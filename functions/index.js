/* eslint-disable */
const functions = require("firebase-functions/v1");   // 1st-gen
const admin = require("firebase-admin");
const cors = require("cors")({ origin: true });
const crypto = require("crypto");
const querystring = require("querystring"); // for Slack slash command parsing

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

// REPORT channel — monthly / on-demand reports go here
const getReportWebhook = () =>
    (functions.config().slack && functions.config().slack.report_webhook_url) || "";

// Restrict processing to this submit channel (ID). Example: "C0123456789"
const getSubmitChannelId = () =>
    (functions.config().slack && functions.config().slack.submit_channel_id) || "";

// Restrict /repport to this report channel (ID). Example: "C0123456789"
const getReportChannelId = () =>
    (functions.config().slack && functions.config().slack.report_channel_id) || "";

// Slack signing secret for Events API & Slash Commands
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

// Optional: tag Abdelfatteh by Slack user ID (else show his name)
const getAbdUserId = () => (functions.config().slack && functions.config().slack.abd_user_id) || "";

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

/** Accept only real App Store URLs (apps.apple.com or itunes.apple.com) and extract numeric id */
function parseAppStoreLink(text = "") {
    const m = String(text).match(/https?:\/\/(?:apps|itunes)\.apple\.com\/[^\s)]+/i);
    if (!m) return null;
    const raw = m[0];
    try {
        const u = new URL(raw);
        const p = u.pathname.match(/\/id(\d{5,})/i);
        let id = p && p[1] ? p[1] : null;
        if (!id) {
            const q = u.searchParams.get("id");
            if (q && /^\d{5,}$/.test(q)) id = q;
        }
        if (id) return { id, url: raw };
    } catch (_) { }
    return null;
}

/** Month stamp in Africa/Tunis, "YYYY-MM" — used for grouping reports */
function monthStampTunis(date = new Date()) {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis", year: "numeric", month: "2-digit" });
    const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}`; // e.g. "2025-08"
}
/** Human date "YYYY-MM-DD" in Africa/Tunis */
function dateStrTunis(date = new Date()) {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis", year: "numeric", month: "2-digit", day: "2-digit" });
    return fmt.format(date);
}
/** Friendly month name */
function monthLabel(stamp /* "YYYY-MM" */) {
    const [y, m] = stamp.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    return d.toLocaleString("en-US", { month: "long", year: "numeric" }); // e.g. "August 2025"
}
/** Is today the last day of month in Africa/Tunis? */
function isLastDayOfMonthTunis(now = new Date()) {
    const today = dateStrTunis(now).slice(0, 10); // "YYYY-MM-DD"
    const [y, m, d] = today.split("-").map(Number);
    const end = new Date(Date.UTC(y, m, 0)); // last day (UTC month trick)
    const endStrLocal = dateStrTunis(end);
    return today === endStrLocal;
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

                    // Post LIVE to UPDATES (with ping if configured)
                    await postToWebhook(getUpdatesWebhook(), { text: liveMessage(name, link), icon, ping: true });

                    // Mark announced with month + uploader (if known from monitor)
                    await db.collection("announcedApps").doc(keyDoc).set({
                        id: m.id || null,
                        bundleId: m.bundleId || null,
                        name,
                        link,
                        uploader: (m.source && m.source.user) || null, // Slack user id
                        announcedMonth: monthStampTunis(new Date()),
                        announcedAt: admin.firestore.FieldValue.serverTimestamp(),
                    }, { merge: true });

                    // Start tracking this app for daily monitoring
                    await db.collection("trackedApps").doc(keyDoc).set({
                        id: m.id || null,
                        bundleId: m.bundleId || null,
                        name,
                        link,
                        uploader: (m.source && m.source.user) || null,
                        firstLiveAt: admin.firestore.FieldValue.serverTimestamp(),
                        lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                        status: "live", // live, terminated, confirmed
                        terminationDate: null,
                        confirmationDate: null,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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

            // Only accept messages from the configured submit channel (optional)
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

                // 2) Already announced?
                const announced = await db.collection("announcedApps").doc(keyDoc).get();
                if (announced.exists) {
                    const d = announced.data() || {};
                    await postToWebhook(getSubmitWebhook(), {
                        text: `ℹ️ *${d.name || id}* was already announced as LIVE. See #app-checker-updates.`,
                        icon: null
                    });
                    return res.status(200).send("already-announced");
                }

                // 3) Already subscribed?
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
                    // Already live -> announce in UPDATES (with ping), mark announced, ack in SUBMIT
                    const name = liveNow[0].trackName || id;
                    const link = liveNow.find(r => r.viewUrl)?.viewUrl || fallbackStoreLink({ id });
                    const icon = liveNow.find(r => r.artworkUrl100)?.artworkUrl100 || null;

                    await postToWebhook(getUpdatesWebhook(), { text: liveMessage(name, link), icon, ping: true });
                    await db.collection("announcedApps").doc(keyDoc).set({
                        id,
                        bundleId: null,
                        name,
                        link,
                        uploader: ev.user || null, // Slack user id
                        announcedMonth: monthStampTunis(new Date()),
                        announcedAt: admin.firestore.FieldValue.serverTimestamp(),
                        source: { channel: ev.channel, immediate: true },
                    }, { merge: true });

                    // Start tracking this app for daily monitoring
                    await db.collection("trackedApps").doc(keyDoc).set({
                        id,
                        bundleId: null,
                        name,
                        link,
                        uploader: ev.user || null,
                        firstLiveAt: admin.firestore.FieldValue.serverTimestamp(),
                        lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                        status: "live", // live, terminated, confirmed
                        terminationDate: null,
                        confirmationDate: null,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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

/* ===================================== Daily App Tracking ===================================== */
/** Check if an app is still live by checking a few key countries */
async function checkAppStillLive({ id, bundleId }) {
    const keyCountries = ["us", "gb", "fr", "de", "ca", "au"]; // Check major markets
    const data = await checkAcrossCountries({ id, bundleId, countries: keyCountries });
    const liveCount = data.results.filter(r => r.live).length;
    return liveCount > 0; // Consider live if available in at least one major market
}

/** Calculate days between two dates */
function daysBetween(date1, date2) {
    const oneDay = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds
    return Math.round(Math.abs((date2 - date1) / oneDay));
}

/** Format days into human readable string */
function formatDays(days) {
    if (days === 0) return "same day";
    if (days === 1) return "1 day";
    if (days < 7) return `${days} days`;
    const weeks = Math.floor(days / 7);
    const remainingDays = days % 7;
    if (weeks === 1 && remainingDays === 0) return "1 week";
    if (remainingDays === 0) return `${weeks} weeks`;
    return `${weeks} week${weeks > 1 ? 's' : ''} and ${remainingDays} day${remainingDays > 1 ? 's' : ''}`;
}

/** Send termination message to updates channel */
async function sendTerminationMessage(app, daysSinceLive) {
    const name = app.name || (app.id ? `App ID ${app.id}` : `Bundle ID ${app.bundleId}`);
    const link = app.link || (app.id ? fallbackStoreLink({ id: app.id }) : null);
    const uploader = app.uploader ? `<@${app.uploader}>` : "Unknown";
    const duration = formatDays(daysSinceLive);
    
    const text = `🚫 *${name}* has been terminated after ${duration}.\n` +
                `Uploaded by ${uploader}${link ? `\n${link}` : ""}`;
    
    await postToWebhook(getUpdatesWebhook(), { 
        text, 
        icon: null, 
        ping: false 
    });
}

/** Send confirmation message to updates channel */
async function sendConfirmationMessage(app) {
    const name = app.name || (app.id ? `App ID ${app.id}` : `Bundle ID ${app.bundleId}`);
    const link = app.link || (app.id ? fallbackStoreLink({ id: app.id }) : null);
    const uploader = app.uploader ? `<@${app.uploader}>` : "Unknown";
    
    const text = `✅ *${name}* is confirmed live after 3 weeks!\n` +
                `Uploaded by ${uploader}${link ? `\n${link}` : ""}`;
    
    await postToWebhook(getUpdatesWebhook(), { 
        text, 
        icon: null, 
        ping: false 
    });
}

/* Daily cron job to check tracked apps */
exports.dailyAppTracking = functions
    .region("us-central1")
    .pubsub.schedule("0 9 * * *")   // 9:00 AM every day (Africa/Tunis timezone)
    .timeZone("Africa/Tunis")
    .onRun(async () => {
        const db = admin.firestore();
        const now = new Date();
        const threeWeeksAgo = new Date(now.getTime() - (21 * 24 * 60 * 60 * 1000));
        
        // Get all tracked apps that are still being monitored
        const snap = await db.collection("trackedApps")
            .where("status", "==", "live")
            .get();
        
        if (snap.empty) return null;
        
        console.log(`Checking ${snap.docs.length} tracked apps for daily monitoring`);
        
        for (const doc of snap.docs) {
            const app = doc.data();
            try {
                // Check if app is still live
                const isStillLive = await checkAppStillLive({ 
                    id: app.id, 
                    bundleId: app.bundleId 
                });
                
                const firstLiveDate = app.firstLiveAt ? app.firstLiveAt.toDate() : null;
                if (!firstLiveDate) {
                    console.warn(`App ${doc.id} has no firstLiveAt date, skipping`);
                    continue;
                }
                
                const daysSinceLive = daysBetween(firstLiveDate, now);
                const isPastThreeWeeks = firstLiveDate <= threeWeeksAgo;
                
                if (!isStillLive) {
                    // App has been terminated
                    console.log(`App ${doc.id} (${app.name}) terminated after ${daysSinceLive} days`);
                    
                    await doc.ref.update({
                        status: "terminated",
                        terminationDate: admin.firestore.FieldValue.serverTimestamp(),
                        lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    
                    await sendTerminationMessage(app, daysSinceLive);
                    
                } else if (isPastThreeWeeks && app.status === "live") {
                    // App has passed 3 weeks and is still live - confirm it
                    console.log(`App ${doc.id} (${app.name}) confirmed after 3 weeks`);
                    
                    await doc.ref.update({
                        status: "confirmed",
                        confirmationDate: admin.firestore.FieldValue.serverTimestamp(),
                        lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    
                    await sendConfirmationMessage(app);
                    
                } else {
                    // App is still live but hasn't reached 3 weeks yet - just update last checked
                    await doc.ref.update({
                        lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                }
                
            } catch (err) {
                console.error(`Error checking app ${doc.id}:`, err);
                // Update last checked even on error to avoid retrying immediately
                await doc.ref.update({
                    lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            }
        }
        
        return null;
    });

/* ===================================== Migration ===================================== */
exports.migrateAnnouncedGames = functions
    .region("us-central1")
    .https.onRequest(async (req, res) => {
        cors(req, res, async () => {
            if (req.method === "OPTIONS") return res.status(204).send("");
            
            try {
                const db = admin.firestore();
                
                // Get all announced apps that don't have corresponding tracked apps
                const announcedSnap = await db.collection("announcedApps").get();
                const trackedSnap = await db.collection("trackedApps").get();
                
                const trackedKeys = new Set();
                trackedSnap.forEach(doc => {
                    const data = doc.data();
                    const key = data.id ? `id:${data.id}` : `bid:${data.bundleId}`;
                    trackedKeys.add(key);
                });
                
                let migrated = 0;
                const batch = db.batch();
                
                for (const doc of announcedSnap.docs) {
                    const data = doc.data();
                    const key = data.id ? `id:${data.id}` : `bid:${data.bundleId}`;
                    
                    if (!trackedKeys.has(key)) {
                        const trackedRef = db.collection("trackedApps").doc(key);
                        batch.set(trackedRef, {
                            id: data.id || null,
                            bundleId: data.bundleId || null,
                            name: data.name || (data.id ? `App ID ${data.id}` : `Bundle ID ${data.bundleId}`),
                            link: data.link || (data.id ? fallbackStoreLink({ id: data.id }) : null),
                            uploader: data.uploader || null,
                            firstLiveAt: data.announcedAt || admin.firestore.FieldValue.serverTimestamp(),
                            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                            status: "unknown", // Will be updated by daily tracking
                            terminationDate: null,
                            confirmationDate: null,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        });
                        migrated++;
                    }
                }
                
                if (migrated > 0) {
                    await batch.commit();
                }
                
                return res.json({
                    ok: true,
                    migrated,
                    message: `Successfully migrated ${migrated} announced games to tracked apps`
                });
                
            } catch (e) {
                console.error("Migration error:", e);
                return res.status(500).json({ error: String(e) });
            }
        });
    });

/* ===================================== Manual Status Check ===================================== */
exports.checkGameStatuses = functions
    .region("us-central1")
    .https.onRequest(async (req, res) => {
        cors(req, res, async () => {
            if (req.method === "OPTIONS") return res.status(204).send("");
            
            try {
                const db = admin.firestore();
                
                // Get all tracked apps with unknown status
                const snap = await db.collection("trackedApps")
                    .where("status", "==", "unknown")
                    .get();
                
                if (snap.empty) {
                    return res.json({
                        ok: true,
                        message: "No games with unknown status found",
                        checked: 0
                    });
                }
                
                let checked = 0;
                let updated = 0;
                
                for (const doc of snap.docs) {
                    const app = doc.data();
                    try {
                        // Check if app is still live
                        const isStillLive = await checkAppStillLive({ 
                            id: app.id, 
                            bundleId: app.bundleId 
                        });
                        
                        const firstLiveDate = app.firstLiveAt ? app.firstLiveAt.toDate() : null;
                        if (!firstLiveDate) {
                            console.warn(`App ${doc.id} has no firstLiveAt date, skipping`);
                            continue;
                        }
                        
                        const now = new Date();
                        const daysSinceLive = daysBetween(firstLiveDate, now);
                        const threeWeeksAgo = new Date(now.getTime() - (21 * 24 * 60 * 60 * 1000));
                        const isPastThreeWeeks = firstLiveDate <= threeWeeksAgo;
                        
                        let newStatus = "unknown";
                        if (!isStillLive) {
                            newStatus = "terminated";
                        } else if (isPastThreeWeeks) {
                            newStatus = "confirmed";
                        } else {
                            newStatus = "live";
                        }
                        
                        // Update the status
                        await doc.ref.update({
                            status: newStatus,
                            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        });
                        
                        if (newStatus !== "unknown") {
                            updated++;
                        }
                        checked++;
                        
                        console.log(`App ${doc.id} (${app.name}) status updated to: ${newStatus}`);
                        
                    } catch (err) {
                        console.error(`Error checking app ${doc.id}:`, err);
                    }
                }
                
                return res.json({
                    ok: true,
                    checked,
                    updated,
                    message: `Checked ${checked} games, updated ${updated} statuses`
                });
                
            } catch (e) {
                console.error("Error checking game statuses:", e);
                return res.status(500).json({ error: String(e) });
            }
        });
    });

/* ===================================== Dashboard API ===================================== */
exports.getAnnouncedGames = functions
    .region("us-central1")
    .https.onRequest(async (req, res) => {
        cors(req, res, async () => {
            if (req.method === "OPTIONS") return res.status(204).send("");
            
            try {
                const db = admin.firestore();
                
                // Get announced apps
                const announcedSnap = await db.collection("announcedApps")
                    .orderBy("announcedAt", "desc")
                    .limit(100)
                    .get();
                
                // Get tracked apps for status information
                const trackedSnap = await db.collection("trackedApps")
                    .get();
                
                const trackedAppsMap = new Map();
                trackedSnap.forEach(doc => {
                    const data = doc.data();
                    const key = data.id ? `id:${data.id}` : `bid:${data.bundleId}`;
                    trackedAppsMap.set(key, data);
                });
                
                const games = [];
                announcedSnap.forEach(doc => {
                    const data = doc.data();
                    const key = data.id ? `id:${data.id}` : `bid:${data.bundleId}`;
                    const trackedData = trackedAppsMap.get(key);
                    
                    games.push({
                        id: data.id || data.bundleId,
                        name: data.name || (data.id ? `App ID ${data.id}` : `Bundle ID ${data.bundleId}`),
                        link: data.link || (data.id ? fallbackStoreLink({ id: data.id }) : null),
                        uploader: data.uploader,
                        announcedAt: data.announcedAt ? data.announcedAt.toDate().toISOString() : null,
                        announcedMonth: data.announcedMonth,
                        source: data.source,
                        // Status from tracked apps
                        status: trackedData?.status || "unknown",
                        firstLiveAt: trackedData?.firstLiveAt ? trackedData.firstLiveAt.toDate().toISOString() : null,
                        lastCheckedAt: trackedData?.lastCheckedAt ? trackedData.lastCheckedAt.toDate().toISOString() : null,
                        terminationDate: trackedData?.terminationDate ? trackedData.terminationDate.toDate().toISOString() : null,
                        confirmationDate: trackedData?.confirmationDate ? trackedData.confirmationDate.toDate().toISOString() : null,
                    });
                });
                
                res.set("Cache-Control", "public, max-age=60, s-maxage=300");
                return res.json({
                    ok: true,
                    count: games.length,
                    games
                });
                
            } catch (e) {
                console.error("Error fetching announced games:", e);
                return res.status(500).json({ error: String(e) });
            }
        });
    });

/* ===================================== Reports ===================================== */
// Build Slack-friendly report text for monthStamp "YYYY-MM"
// Uses Firestore index (announcedMonth == monthStamp, orderBy announcedAt asc)
async function buildMonthlyReport(monthStamp) {
    const db = admin.firestore();
    const q = await db.collection("announcedApps")
        .where("announcedMonth", "==", monthStamp)
        .orderBy("announcedAt", "asc")
        .get();

    const games = [];
    const perUploader = new Map(); // userId -> count

    q.forEach(doc => {
        const d = doc.data() || {};
        const id = d.id || d.bundleId || doc.id;
        const name = d.name || id;
        const link = d.link || (d.id ? fallbackStoreLink({ id: d.id }) : null);
        const uploader = d.uploader || null; // Slack user id
        const announcedAt = d.announcedAt ? d.announcedAt.toDate() : null;

        games.push({ id, name, link, uploader, announcedAt });
        if (uploader) perUploader.set(uploader, (perUploader.get(uploader) || 0) + 1);
    });

    // Get tracking data for terminated and confirmed apps
    const trackingSnap = await db.collection("trackedApps")
        .where("firstLiveAt", ">=", new Date(`${monthStamp}-01`))
        .where("firstLiveAt", "<", new Date(`${monthStamp}-01`).setMonth(new Date(`${monthStamp}-01`).getMonth() + 1))
        .get();

    const terminatedApps = [];
    const confirmedApps = [];
    
    trackingSnap.forEach(doc => {
        const d = doc.data() || {};
        if (d.status === "terminated") {
            terminatedApps.push(d);
        } else if (d.status === "confirmed") {
            confirmedApps.push(d);
        }
    });

    const count = games.length;
    const PER_GAME = 50;

    const label = monthLabel(monthStamp);
    const firstDay = `${monthStamp}-01`;
    const [y, m] = monthStamp.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lastStr = `${monthStamp}-${String(lastDay).padStart(2, "0")}`;

    const header =
        `📊 Monthly Report — ${label}\n\n` +
        `**Overview**\n` +
        `• Live launches: *${count}*\n` +
        `• Confirmed after 3 weeks: *${confirmedApps.length}*\n` +
        `• Terminated before 3 weeks: *${terminatedApps.length}*\n` +
        `• Period: ${firstDay}–${lastStr} (Africa/Tunis)\n`;

    if (count === 0) {
        return `${header}\nNo apps went LIVE this month. Paste App Store links in #app-checker-submit to subscribe.`;
    }

    // Per-person payout lines (uploaders + Abdelfatteh). No label line, no grand total.
    const uploaderLines = [...perUploader.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([uid, c]) => `• <@${uid}> — ${c} game${c > 1 ? "s" : ""} → $${c * PER_GAME}`);
    if (uploaderLines.length === 0) uploaderLines.push("• (no tagged uploaders yet)");

    const abdName = getAbdUserId() ? `<@${getAbdUserId()}>` : "Abdelfatteh Adhadhi";
    const abdLine = `• ${abdName} — ${count} × $${PER_GAME} → $${count * PER_GAME}`;

    const payouts = `**Payouts**\n${uploaderLines.join("\n")}\n${abdLine}`;

    // Detailed game list
    const gamesBlock = games.map((g, idx) => {
        const when = g.announcedAt ? dateStrTunis(g.announcedAt) : "—";
        const who = g.uploader ? `<@${g.uploader}>` : "—";
        const link = g.link ? `<${g.link}|App Store>` : "";
        return `${idx + 1}) 🎮 *${g.name}* — ${link}\n   Submitted by ${who} • Announced: ${when} • ID: ${g.id}`;
    }).join("\n");

    // Terminated apps section
    let terminatedBlock = "";
    if (terminatedApps.length > 0) {
        terminatedBlock = "\n\n**Terminated Apps**\n" + terminatedApps.map((app, idx) => {
            const name = app.name || (app.id ? `App ID ${app.id}` : `Bundle ID ${app.bundleId}`);
            const who = app.uploader ? `<@${app.uploader}>` : "—";
            const link = app.link ? `<${app.link}|App Store>` : "";
            const terminatedAt = app.terminationDate ? dateStrTunis(app.terminationDate.toDate()) : "—";
            const firstLiveAt = app.firstLiveAt ? dateStrTunis(app.firstLiveAt.toDate()) : "—";
            return `${idx + 1}) 🚫 *${name}* — ${link}\n   Uploaded by ${who} • Live: ${firstLiveAt} • Terminated: ${terminatedAt}`;
        }).join("\n");
    }

    // Confirmed apps section
    let confirmedBlock = "";
    if (confirmedApps.length > 0) {
        confirmedBlock = "\n\n**Confirmed Apps (3+ weeks)**\n" + confirmedApps.map((app, idx) => {
            const name = app.name || (app.id ? `App ID ${app.id}` : `Bundle ID ${app.bundleId}`);
            const who = app.uploader ? `<@${app.uploader}>` : "—";
            const link = app.link ? `<${app.link}|App Store>` : "";
            const confirmedAt = app.confirmationDate ? dateStrTunis(app.confirmationDate.toDate()) : "—";
            const firstLiveAt = app.firstLiveAt ? dateStrTunis(app.firstLiveAt.toDate()) : "—";
            return `${idx + 1}) ✅ *${name}* — ${link}\n   Uploaded by ${who} • Live: ${firstLiveAt} • Confirmed: ${confirmedAt}`;
        }).join("\n");
    }

    return `${header}\n${payouts}\n\n**Games**\n${gamesBlock}${terminatedBlock}${confirmedBlock}`;
}

/* Slash command: /repport  (current month-to-date, ONLY in report channel) */
exports.slackReportCommand = functions
    .region("us-central1")
    .https.onRequest(async (req, res) => {
        if (!verifySlackSignature(req)) return res.status(401).send("bad signature");

        // Slash commands send x-www-form-urlencoded
        const body = querystring.parse(req.rawBody.toString("utf8"));
        const command = body.command;
        const channelId = body.channel_id;   // where the command was invoked
        const onlyReportId = getReportChannelId();

        if (command !== "/repport") {
            return res.status(200).json({ response_type: "ephemeral", text: "Unknown command." });
        }

        // Enforce: only allowed in the configured report channel
        if (onlyReportId && channelId !== onlyReportId) {
            return res.status(200).json({
                response_type: "ephemeral",
                text: `❌ Please run /repport in <#${onlyReportId}>.`,
            });
        }

        // 1) QUICK ACK (must be <3s)
        res.status(200).json({
            response_type: "ephemeral",
            text: `🧾 Working on this month’s report… I’ll post it in <#${onlyReportId || "your-report-channel"}> shortly.`,
        });

        // 2) Do the work AFTER acknowledging to Slack
        (async () => {
            try {
                const stamp = monthStampTunis(new Date());   // current month
                const text = await buildMonthlyReport(stamp);
                await postToWebhook(getReportWebhook(), { text, icon: null, ping: false });
            } catch (err) {
                // Best-effort error post to report channel
                try {
                    await postToWebhook(getReportWebhook(), {
                        text: `⚠️ Report generation failed: ${String(err)}`,
                        icon: null,
                        ping: false
                    });
                } catch (_) { }
            }
        })();
    });


/* Daily cron near end of day; if it's the last day of month, post the monthly report */
exports.monthlyReportCron = functions
    .region("us-central1")
    .pubsub.schedule("55 23 * * *")   // 23:55 every day
    .timeZone("Africa/Tunis")
    .onRun(async () => {
        if (!isLastDayOfMonthTunis(new Date())) return null;
        const stamp = monthStampTunis(new Date());
        const text = await buildMonthlyReport(stamp);
        await postToWebhook(getReportWebhook(), { text, icon: null, ping: false });
        return null;
    });
