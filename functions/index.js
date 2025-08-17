/* eslint-disable */
const functions = require("firebase-functions/v1");   // 1st-gen
const admin = require("firebase-admin");
const cors = require("cors")({ origin: true });
const crypto = require("crypto");

// Node 18+ has global.fetch. Keep a fallback for older local shells.
const fetch = global.fetch
    ? global.fetch.bind(global)
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

admin.initializeApp();

/* ======================= Config (set via `firebase functions:config:set`) ======================= */
// UPDATES channel — LIVE alerts go here
const getUpdatesWebhook = () =>
    (functions.config().slack && (functions.config().slack.updates_webhook_url || functions.config().slack.webhook_url)) || "";

// SUBMIT channel — confirmations / errors go here
const getSubmitWebhook = () =>
    (functions.config().slack && (functions.config().slack.confirm_webhook_url || functions.config().slack.updates_webhook_url || functions.config().slack.webhook_url)) || "";

// Restrict processing to this submit channel (optional but recommended)
const getSubmitChannelId = () =>
    (functions.config().slack && functions.config().slack.submit_channel_id) || "";

// Slack signing secret for Events API
const getSlackSigningSecret = () =>
    (functions.config().slack && functions.config().slack.signing_secret) || "";

// Mass-mention mode for UPDATES messages only: "", "channel", "here", "everyone"
function getPingToken() {
    const mode = ((functions.config().slack && functions.config().slack.ping_mode) || "").toLowerCase();
    if (mode === "channel") return "<!channel> ";
    if (mode === "here") return "<!here> ";
    if (mode === "everyone") return "<!everyone> ";
    return "";
}

// (Optional) API key used by /addMonitor
const getMonitorApiKey = () =>
    (functions.config().monitor && functions.config().monitor.api_key) || "";

/* ===================================== Defaults ===================================== */
const COUNTRY_CODES = [
    "us", "gb", "fr", "de", "it", "es", "se", "no", "dk", "fi", "nl", "be", "ie", "pt",
    "ca", "mx", "br", "ar", "cl", "cn", "co", "pe",
    "au", "nz", "jp", "kr", "tw", "hk", "sg", "my", "th", "vn", "ph", "id", "in",
    "sa", "ae", "eg", "ma", "tn", "za", "tr"
];

function getCountryList(requested) {
    if (Array.isArray(requested) && requested.length) {
        const set = new Set(
            requested.map(c => String(c || "").toLowerCase()).filter(c => COUNTRY_CODES.includes(c))
        );
        if (set.size) return [...set];
    }
    if (typeof requested === "string" && requested.trim()) {
        const arr = requested.split(",").map(s => s.trim().toLowerCase());
        const set = new Set(arr.filter(c => COUNTRY_CODES.includes(c)));
        if (set.size) return [...set];
    }
    return COUNTRY_CODES;
}

/* ===================================== Helpers ===================================== */
function liveMessage(name, link) {
    return `🎉 *${name}* is LIVE on the App Store!${link ? `\n${link}` : ""}`;
}
function fallbackStoreLink({ id, country = "us" }) {
    return id ? `https://apps.apple.com/${country}/app/id${id}` : null;
}
async function postToWebhook(webhookUrl, { text, icon, ping = false }) {
    if (!webhookUrl) {
        console.warn("No webhook configured; skipping message.", { text });
        return;
    }
    const prefix = ping ? getPingToken() : "";
    const composed = prefix + text;

    const payload = {
        text: composed,
        blocks: [
            ...(icon ? [{ type: "image", image_url: icon, alt_text: "App icon" }] : []),
            { type: "section", text: { type: "mrkdwn", text: composed } }
        ],
    };
    await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

/** Accept only real App Store URLs (apps.apple.com or itunes.apple.com) and extract the numeric id */
function parseAppStoreLink(text = "") {
    const m = String(text).match(/https?:\/\/(?:apps|itunes)\.apple\.com\/[^\s)]+/i);
    if (!m) return null;
    const raw = m[0];
    try {
        const u = new URL(raw);
        // Try /.../id123...
        const p = u.pathname.match(/\/id(\d{5,})/i);
        let id = p && p[1] ? p[1] : null;
        // Fallback: ?id=123...
        if (!id) {
            const q = u.searchParams.get("id");
            if (q && /^\d{5,}$/.test(q)) id = q;
        }
        if (id) return { id, url: raw };
    } catch (_) { }
    return null;
}

/* ===================================== Lookup ===================================== */
async function lookupBy({ country, id, bundleId }) {
    const params = new URLSearchParams({ country });
    if (id) params.set("id", id);
    if (bundleId) params.set("bundleId", bundleId);
    const url = `https://itunes.apple.com/lookup?${params.toString()}`;

    try {
        const res = await fetch(url);
        if (!res.ok) return { country, live: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        if (data && data.resultCount > 0 && Array.isArray(data.results) && data.results.length) {
            const app = data.results[0];
            return {
                country,
                live: true,
                trackName: app.trackName,
                sellerName: app.sellerName,
                version: app.version,
                releaseDate: app.releaseDate,
                currentVersionReleaseDate: app.currentVersionReleaseDate,
                viewUrl: app.trackViewUrl,
                artworkUrl100: app.artworkUrl100 || app.artworkUrl60 || null,
            };
        }
        return { country, live: false };
    } catch (e) {
        return { country, live: false, error: String(e) };
    }
}

async function checkAcrossCountries({ id, bundleId, countries }) {
    const list = getCountryList(countries);
    const CONCURRENCY = 8;
    const chunks = [];
    for (let i = 0; i < list.length; i += CONCURRENCY) chunks.push(list.slice(i, i + CONCURRENCY));

    const results = [];
    for (const chunk of chunks) {
        const batch = await Promise.all(chunk.map(country => lookupBy({ country, id, bundleId })));
        results.push(...batch);
    }

    return {
        ok: true,
        query: { id: id || null, bundleId: bundleId || null, count: list.length },
        results,
        summary: {
            liveCount: results.filter(r => r.live).length,
            notLiveCount: results.filter(r => !r.live && !r.error).length,
            errorCount: results.filter(r => r.error).length,
        },
    };
}

/* ===================================== Public API ===================================== */
exports.checkAppStatus = functions
    .region("us-central1")
    .https.onRequest(async (req, res) => {
        cors(req, res, async () => {
            if (req.method === "OPTIONS") return res.status(204).send("");
            try {
                const body = req.body || {};
                const id = body.id || req.query.id || null;
                const bundleId = body.bundleId || req.query.bundleId || null;
                const countriesRequested = body.countries ?? req.query.countries;

                if (!id && !bundleId) {
                    return res.status(400).json({ error: "Provide either 'id' or 'bundleId'." });
                }

                const data = await checkAcrossCountries({ id, bundleId, countries: countriesRequested });
                res.set("Cache-Control", "public, max-age=60, s-maxage=300");
                return res.json(data);
            } catch (e) {
                return res.status(500).json({ error: String(e) });
            }
        });
    });

/* ===================================== Monitor API (protected) ===================================== */
exports.addMonitor = functions
    .region("us-central1")
    .https.onRequest(async (req, res) => {
        cors(req, res, async () => {
            if (req.method === "OPTIONS") return res.status(204).send("");

            const expectedKey = getMonitorApiKey();
            const key = req.get("x-api-key");
            if (!expectedKey || !key || key !== expectedKey) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            try {
                const body = req.body || {};
                const id = body.id || null;
                const bundleId = body.bundleId || null;
                if (!id && !bundleId) return res.status(400).json({ error: "Provide 'id' or 'bundleId'." });

                const countries = getCountryList(body.countries);
                const webhookUrl = null; // use default updates webhook
                const db = admin.firestore();
                const keyDoc = id ? `id:${id}` : `bid:${bundleId}`;
                await upsertMonitor(db, keyDoc, {
                    id: id || null,
                    bundleId: bundleId || null,
                    countries,
                    mode: "firstLive",
                    webhookUrl,
                    lastLiveCountries: [],
                });

                return res.json({ ok: true, id: keyDoc });
            } catch (e) {
                return res.status(500).json({ error: String(e) });
            }
        });
    });

async function upsertMonitor(db, keyDoc, data) {
    const ref = db.collection("appMonitors").doc(keyDoc);
    const snap = await ref.get();
    if (!snap.exists) {
        await ref.set({
            ...data,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } else {
        await ref.update({
            ...data,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    }
}

/* ===================================== Scheduler (hourly) ===================================== */
exports.monitorApps = functions
    .region("us-central1")
    .pubsub.schedule("every 60 minutes")
    .timeZone("Africa/Tunis")
    .onRun(async () => {
        const db = admin.firestore();
        const snap = await db.collection("appMonitors").get();
        if (snap.empty) return null;

        for (const doc of snap.docs) {
            const m = doc.data();
            try {
                const data = await checkAcrossCountries({ id: m.id, bundleId: m.bundleId, countries: m.countries });
                const liveNow = data.results.filter(r => r.live);
                if (liveNow.length > 0) {
                    const name = liveNow[0].trackName || (m.id || m.bundleId);
                    const link = liveNow.find(r => r.viewUrl)?.viewUrl || fallbackStoreLink({ id: m.id });
                    const icon = liveNow.find(r => r.artworkUrl100)?.artworkUrl100 || null;
                    const keyDoc = m.id ? `id:${m.id}` : `bid:${m.bundleId}`;

                    // Post LIVE to UPDATES channel (with ping if configured), mark announced, then stop monitoring
                    await postToWebhook(getUpdatesWebhook(), { text: liveMessage(name, link), icon, ping: true });
                    await db.collection("announcedApps").doc(keyDoc).set({
                        id: m.id || null,
                        bundleId: m.bundleId || null,
                        name,
                        link,
                        announcedAt: admin.firestore.FieldValue.serverTimestamp(),
                    }, { merge: true });
                    await doc.ref.delete();
                }
            } catch (err) {
                console.error(`Monitor ${doc.id} failed:`, err);
            }
        }
        return null;
    });

/* ===================================== Slack Events (submit channel -> updates channel) ===================================== */
function verifySlackSignature(req) {
    const signingSecret = getSlackSigningSecret();
    if (!signingSecret) return false;
    const ts = req.get("x-slack-request-timestamp");
    const sig = req.get("x-slack-signature");
    if (!ts || !sig) return false;

    const FIVE_MIN = 60 * 5;
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > FIVE_MIN) return false;

    const base = `v0:${ts}:${req.rawBody.toString("utf8")}`;
    const mySig = "v0=" + crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
    try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mySig));
    } catch {
        return false;
    }
}
function isSlackRetry(req) {
    const num = req.get("x-slack-retry-num");
    const reason = req.get("x-slack-retry-reason");
    return (typeof num !== "undefined" && num !== null) || (typeof reason !== "undefined" && reason !== null);
}

exports.slackEvents = functions
    .region("us-central1")
    .https.onRequest(async (req, res) => {
        if (!verifySlackSignature(req)) return res.status(401).send("bad signature");

        const body = req.body || {};
        if (body.type === "url_verification") return res.status(200).send(body.challenge);
        if (isSlackRetry(req)) return res.status(200).send("retry-ack");

        if (body.type === "event_callback") {
            const ev = body.event || {};
            const db = admin.firestore();

            // Optional: only accept messages from ONE submit channel
            const onlyChannel = getSubmitChannelId();
            if (onlyChannel && ev.channel && ev.channel !== onlyChannel) {
                return res.status(200).send("ignored-other-channel");
            }

            // Dedupe by event_id
            const eventId = body.event_id;
            if (eventId) {
                try {
                    await db.collection("slackEventLog").doc(String(eventId)).create({
                        type: ev.type,
                        channel: ev.channel,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                } catch (err) {
                    const msg = String(err && err.message || "");
                    if (err && (err.code === 6 || err.code === "already-exists" || msg.includes("Already exists"))) {
                        return res.status(200).send("duplicate");
                    }
                    throw err;
                }
            }

            if (ev.type === "message" && !ev.subtype && typeof ev.text === "string") {
                // 1) Must be an App Store link
                const parsed = parseAppStoreLink(ev.text);
                if (!parsed) {
                    await postToWebhook(getSubmitWebhook(), {
                        text: "❌ That doesn't look like an App Store link.\nPlease paste a full URL like `https://apps.apple.com/us/app/.../id1234567890`.",
                        icon: null
                    });
                    return res.status(200).send("bad-link");
                }

                const id = parsed.id;
                const keyDoc = `id:${id}`;

                // 2) If already announced before → warn, do nothing
                const announced = await db.collection("announcedApps").doc(keyDoc).get();
                if (announced.exists) {
                    const d = announced.data() || {};
                    await postToWebhook(getSubmitWebhook(), {
                        text: `ℹ️ *${d.name || id}* was already announced as LIVE. See #app-checker-updates.`,
                        icon: null
                    });
                    return res.status(200).send("already-announced");
                }

                // 3) If already subscribed (monitor exists) → warn, do nothing
                const monRef = db.collection("appMonitors").doc(keyDoc);
                const monSnap = await monRef.get();
                if (monSnap.exists) {
                    await postToWebhook(getSubmitWebhook(), {
                        text: "⚠️ Already subscribed for this app. I’ll notify in #app-checker-updates when it goes live.",
                        icon: null
                    });
                    return res.status(200).send("already-subscribed");
                }

                // 4) Immediate check
                const countries = COUNTRY_CODES;
                const data = await checkAcrossCountries({ id, bundleId: null, countries });
                const liveNow = data.results.filter(r => r.live);

                if (liveNow.length > 0) {
                    // Already live -> announce in UPDATES channel (with ping), mark announced, short ack in SUBMIT
                    const name = liveNow[0].trackName || id;
                    const link = liveNow.find(r => r.viewUrl)?.viewUrl || fallbackStoreLink({ id });
                    const icon = liveNow.find(r => r.artworkUrl100)?.artworkUrl100 || null;

                    await postToWebhook(getUpdatesWebhook(), { text: liveMessage(name, link), icon, ping: true });
                    await db.collection("announcedApps").doc(keyDoc).set({
                        id,
                        bundleId: null,
                        name,
                        link,
                        announcedAt: admin.firestore.FieldValue.serverTimestamp(),
                        source: { channel: ev.channel, immediate: true },
                    }, { merge: true });

                    await postToWebhook(getSubmitWebhook(), {
                        text: `✅ *${name}* is already live. Posted in #app-checker-updates.`,
                        icon: null
                    });
                } else {
                    // Not live yet -> create monitor and confirm
                    await monRef.set({
                        id,
                        bundleId: null,
                        countries,
                        mode: "firstLive",
                        webhookUrl: null,
                        lastLiveCountries: [],
                        source: { channel: ev.channel, user: ev.user },
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });

                    await postToWebhook(getSubmitWebhook(), {
                        text: `📡 Subscribed *id:${id}*. I'll notify in #app-checker-updates when it goes live.`,
                        icon: null
                    });
                }
            }
            return res.status(200).send("ok");
        }

        return res.status(200).send("ignored");
    });
