#!/usr/bin/env node

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 5432);
const SAMPLES_ROOT = path.resolve(process.env.SAMPLES_ROOT || path.join(process.cwd(), "samples"));
const TRACKS_ROOT = path.resolve(process.env.TRACKS_ROOT || path.join(process.cwd(), "tracks"));

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".flac", ".aif", ".aiff", ".m4a"]);

function normalizePart(value) {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/&/g, " and ")
        .replace(/['"]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase();
}

function splitRelative(relPath) {
    const parsed = path.parse(relPath);
    const dirParts = parsed.dir ? parsed.dir.split(path.sep).filter(Boolean) : [];
    return {
        dirParts,
        fileNameNoExt: parsed.name,
        ext: parsed.ext,
    };
}

function getLegacyGroupKey(relPath) {
    const { dirParts, fileNameNoExt } = splitRelative(relPath);

    if (dirParts.length >= 2) {
        return dirParts[1];
    }
    if (dirParts.length === 1) {
        return dirParts[0];
    }
    return fileNameNoExt;
}

function getAliasBaseKey(relPath) {
    const { dirParts, fileNameNoExt } = splitRelative(relPath);
    return [...dirParts, fileNameNoExt].map(normalizePart).filter(Boolean).join("-") || "sample";
}

function contentType(filePath) {
    switch (path.extname(filePath).toLowerCase()) {
        case ".wav":
            return "audio/wav";
        case ".mp3":
            return "audio/mpeg";
        case ".ogg":
            return "audio/ogg";
        case ".flac":
            return "audio/flac";
        case ".aif":
        case ".aiff":
            return "audio/aiff";
        case ".m4a":
            return "audio/mp4";
        case ".json":
            return "application/json; charset=utf-8";
        default:
            return "application/octet-stream";
    }
}

function ensureInside(parent, child) {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function walk(dir, base = dir, acc = []) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const abs = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            await walk(abs, base, acc);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (!AUDIO_EXTENSIONS.has(ext)) {
            continue;
        }

        acc.push(path.relative(base, abs));
    }

    return acc;
}

function toRelativeUrlPath(relativePath) {
    return relativePath.split(path.sep).map(encodeURIComponent).join("/");
}

function toAbsoluteUrlPath(trackName, relativePath) {
    const rel = toRelativeUrlPath(relativePath);

    if (!trackName) {
        return `/${rel}`;
    }

    return `/${encodeURIComponent(trackName)}/${rel}`;
}

function getBaseUrl(trackName) {
    const shownHost = HOST === "0.0.0.0" ? "localhost" : HOST;

    if (!trackName) {
        return `http://${shownHost}:${PORT}/`;
    }

    return `http://${shownHost}:${PORT}/${encodeURIComponent(trackName)}/`;
}

async function resolveDefaultSamplesDir() {
    try {
        const stat = await fsp.stat(SAMPLES_ROOT);
        if (!stat.isDirectory()) {
            return null;
        }
    } catch {
        return null;
    }

    return SAMPLES_ROOT;
}

async function resolveTrackSamplesDir(trackName) {
    const trackDir = path.resolve(TRACKS_ROOT, trackName);
    const samplesDir = path.resolve(trackDir, "samples");

    if (!ensureInside(TRACKS_ROOT, trackDir) || !ensureInside(TRACKS_ROOT, samplesDir)) {
        return null;
    }

    try {
        const stat = await fsp.stat(samplesDir);
        if (!stat.isDirectory()) {
            return null;
        }
    } catch {
        return null;
    }

    return samplesDir;
}

async function buildMaps(trackName, samplesRoot) {
    const files = await walk(samplesRoot);
    files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

    const legacyAbsolute = {};
    const aliasesAbsolute = {};
    const legacyRelative = {};
    const aliasesRelative = {};
    const aliasCounts = new Map();

    for (const rel of files) {
        const relUrl = toRelativeUrlPath(rel);
        const absUrl = toAbsoluteUrlPath(trackName, rel);

        const groupKey = getLegacyGroupKey(rel);

        if (!legacyAbsolute[groupKey]) {
            legacyAbsolute[groupKey] = [];
        }
        if (!legacyRelative[groupKey]) {
            legacyRelative[groupKey] = [];
        }

        legacyAbsolute[groupKey].push(absUrl);
        legacyRelative[groupKey].push(relUrl);

        const aliasBase = getAliasBaseKey(rel);
        let alias = aliasBase;

        if (Object.prototype.hasOwnProperty.call(aliasesAbsolute, alias)) {
            const next = (aliasCounts.get(aliasBase) ?? 1) + 1;
            aliasCounts.set(aliasBase, next);
            alias = `${aliasBase}-${next}`;
        } else {
            aliasCounts.set(aliasBase, 1);
        }

        aliasesAbsolute[alias] = absUrl;
        aliasesRelative[alias] = relUrl;
    }

    const combined = {
        _base: getBaseUrl(trackName),
        ...legacyRelative,
        ...aliasesRelative,
    };

    return {
        legacy: legacyAbsolute,
        aliases: aliasesAbsolute,
        combined,
    };
}

async function safeResolveDefaultFile(urlParts) {
    const samplesDir = await resolveDefaultSamplesDir();
    if (!samplesDir) {
        return null;
    }

    const decodedParts = urlParts.map(decodeURIComponent);
    const abs = path.resolve(samplesDir, ...decodedParts);

    if (!ensureInside(samplesDir, abs)) {
        return null;
    }

    return abs;
}

async function safeResolveTrackFile(trackName, urlPartsAfterTrack) {
    const samplesDir = await resolveTrackSamplesDir(trackName);
    if (!samplesDir) {
        return null;
    }

    const decodedParts = urlPartsAfterTrack.map(decodeURIComponent);
    const abs = path.resolve(samplesDir, ...decodedParts);

    if (!ensureInside(samplesDir, abs)) {
        return null;
    }

    return abs;
}

const JSON_ENDPOINTS = new Set(["aliases.json", "legacy.json", "strudel.json", "samples.json"]);

const server = http.createServer(async (req, res) => {
    try {
        const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const pathname = reqUrl.pathname;
        const parts = pathname.split("/").filter(Boolean);

        if (pathname === "/") {
            const body = JSON.stringify(
                {
                    samplesRoot: SAMPLES_ROOT,
                    tracksRoot: TRACKS_ROOT,
                    routes: [
                        "/aliases.json",
                        "/legacy.json",
                        "/strudel.json",
                        "/samples.json",
                        "/<sample-file>",
                        "/:track/aliases.json",
                        "/:track/legacy.json",
                        "/:track/strudel.json",
                        "/:track/samples.json",
                        "/:track/<sample-file>",
                    ],
                },
                null,
                2,
            );

            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
            });
            res.end(body);
            return;
        }

        // Root JSON endpoints for default samples dir
        if (
            pathname === "/aliases.json" ||
            pathname === "/legacy.json" ||
            pathname === "/strudel.json" ||
            pathname === "/samples.json"
        ) {
            const samplesDir = await resolveDefaultSamplesDir();
            if (!samplesDir) {
                res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("Default samples folder not found");
                return;
            }

            const { aliases, legacy, combined } = await buildMaps(null, samplesDir);

            let body;
            if (pathname === "/aliases.json") {
                body = JSON.stringify(aliases, null, 2);
            } else if (pathname === "/legacy.json") {
                body = JSON.stringify(legacy, null, 2);
            } else {
                body = JSON.stringify(combined, null, 2);
            }

            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            });
            res.end(body);
            return;
        }

        // Try serving default sample files first, unless this is clearly a track JSON route
        if (parts.length >= 1) {
            const isTrackJsonRoute = parts.length >= 2 && JSON_ENDPOINTS.has(parts.slice(1).join("/"));

            if (!isTrackJsonRoute) {
                const filePath = await safeResolveDefaultFile(parts);
                if (filePath) {
                    let stat = null;
                    try {
                        stat = await fsp.stat(filePath);
                    } catch {
                        stat = null;
                    }

                    if (stat && stat.isFile()) {
                        res.writeHead(200, {
                            "Content-Type": contentType(filePath),
                            "Content-Length": stat.size,
                            "Cache-Control": "public, max-age=3600",
                            "Access-Control-Allow-Origin": "*",
                        });
                        fs.createReadStream(filePath).pipe(res);
                        return;
                    }
                }
            }
        }

        // Track-specific routes
        if (parts.length < 2) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }

        const trackName = decodeURIComponent(parts[0]);
        const subPath = parts.slice(1).join("/");

        const samplesDir = await resolveTrackSamplesDir(trackName);
        if (!samplesDir) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Track samples folder not found");
            return;
        }

        if (subPath === "aliases.json") {
            const { aliases } = await buildMaps(trackName, samplesDir);
            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify(aliases, null, 2));
            return;
        }

        if (subPath === "legacy.json") {
            const { legacy } = await buildMaps(trackName, samplesDir);
            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify(legacy, null, 2));
            return;
        }

        if (subPath === "strudel.json" || subPath === "samples.json") {
            const { combined } = await buildMaps(trackName, samplesDir);
            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify(combined, null, 2));
            return;
        }

        const filePath = await safeResolveTrackFile(trackName, parts.slice(1));
        if (!filePath) {
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Forbidden");
            return;
        }

        let stat;
        try {
            stat = await fsp.stat(filePath);
        } catch {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }

        if (!stat.isFile()) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }

        res.writeHead(200, {
            "Content-Type": contentType(filePath),
            "Content-Length": stat.size,
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
        });

        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Internal Server Error\n${err?.stack || err}`);
    }
});

server.listen(PORT, HOST, () => {
    const shownHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log(`Samples root:   ${SAMPLES_ROOT}`);
    console.log(`Tracks root:    ${TRACKS_ROOT}`);
    console.log(`Server:         http://${shownHost}:${PORT}/`);
    console.log(`Root alias:     http://${shownHost}:${PORT}/aliases.json`);
    console.log(`Root legacy:    http://${shownHost}:${PORT}/legacy.json`);
    console.log(`Root map:       http://${shownHost}:${PORT}/strudel.json`);
    console.log(`Track alias:    http://${shownHost}:${PORT}/<track-name>/aliases.json`);
    console.log(`Track legacy:   http://${shownHost}:${PORT}/<track-name>/legacy.json`);
    console.log(`Track map:      http://${shownHost}:${PORT}/<track-name>/strudel.json`);
});
