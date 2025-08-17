/* eslint-disable */
const functions = require('firebase-functions/v1');  // <— compat import
const cors = require("cors")({ origin: true });

// Default storefronts
const COUNTRY_CODES = [
    "us", "gb", "fr", "de", "it", "es", "se", "no", "dk", "fi", "nl", "be", "ie", "pt",
    "ca", "mx", "br", "ar", "cl","cn", "co", "pe",
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

                const countries = getCountryList(countriesRequested);

                // Gentle concurrency
                const CONCURRENCY = 8;
                const chunks = [];
                for (let i = 0; i < countries.length; i += CONCURRENCY) {
                    chunks.push(countries.slice(i, i + CONCURRENCY));
                }

                const results = [];
                for (const chunk of chunks) {
                    const batch = await Promise.all(
                        chunk.map(country => lookupBy({ country, id, bundleId }))
                    );
                    results.push(...batch);
                }

                res.set("Cache-Control", "public, max-age=60, s-maxage=300");
                return res.json({
                    ok: true,
                    query: { id, bundleId, count: countries.length },
                    results,
                    summary: {
                        liveCount: results.filter(r => r.live).length,
                        notLiveCount: results.filter(r => !r.live && !r.error).length,
                        errorCount: results.filter(r => r.error).length,
                    },
                });
            } catch (e) {
                return res.status(500).json({ error: String(e) });
            }
        });
    });
