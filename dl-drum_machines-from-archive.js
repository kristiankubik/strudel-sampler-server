#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const BASE_URL = process.env.BASE_URL || "https://archive.org/download/drum-machines-collection";
const TARGET_DIR = path.resolve(process.env.TARGET_DIR || "./temp/drum-machines-collection");
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 4));

async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
}

function decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function extractFileLinks(html, baseUrl) {
    const normalizedBase = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    const matches = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis)];

    const results = [];
    const seen = new Set();

    for (const match of matches) {
        const rawHref = decodeHtmlEntities(match[1].trim());
        const rawText = decodeHtmlEntities(match[2].replace(/<[^>]*>/g, "").trim());

        if (!rawHref) continue;
        if (!rawText) continue;

        if (rawText === "Go to parent directory") continue;
        if (rawText === "View Contents") continue;
        if (rawHref.startsWith("#")) continue;
        if (rawHref.startsWith("?")) continue;

        let absolute;
        try {
            absolute = new URL(rawHref, normalizedBase).toString();
        } catch {
            continue;
        }

        if (!absolute.startsWith(normalizedBase)) continue;
        if (absolute.endsWith("/")) continue;

        if (!seen.has(absolute)) {
            seen.add(absolute);
            results.push(absolute);
        }
    }

    return results;
}

function fileNameFromUrl(fileUrl) {
    const u = new URL(fileUrl);
    return path.basename(decodeURIComponent(u.pathname));
}

async function getRemoteSize(url) {
    const res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers: {
            "user-agent": "Mozilla/5.0 (Node.js downloader)",
        },
    });

    if (!res.ok) {
        return null;
    }

    const len = res.headers.get("content-length");
    return len ? Number(len) : null;
}

async function shouldSkip(localPath, remoteSize) {
    try {
        const st = await fsp.stat(localPath);
        if (!st.isFile()) return false;
        if (remoteSize == null) return false;
        return st.size === remoteSize;
    } catch {
        return false;
    }
}

async function downloadFileResumable(url, targetPath) {
    const partPath = `${targetPath}.part`;
    const metaPath = `${targetPath}.part.json`;

    let existingSize = 0;
    try {
        const st = await fsp.stat(partPath);
        if (st.isFile()) existingSize = st.size;
    } catch {}

    const partMeta = await getPartMeta(metaPath);

    const headers = {
        "user-agent": "Mozilla/5.0 (Node.js downloader)",
    };

    if (existingSize > 0) {
        headers.Range = `bytes=${existingSize}-`;
        if (partMeta.etag) {
            headers["If-Range"] = partMeta.etag;
        }
    }

    const res = await fetch(url, {
        redirect: "follow",
        headers,
    });

    if (!res.ok || !res.body) {
        throw new Error(`GET failed: ${res.status} ${res.statusText}`);
    }

    const currentMeta = {
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
    };

    if (res.status === 206) {
        await savePartMeta(metaPath, currentMeta);
        const fileStream = fs.createWriteStream(partPath, { flags: "a" });
        await pipeline(res.body, fileStream);
    } else if (res.status === 200) {
        await savePartMeta(metaPath, currentMeta);
        const fileStream = fs.createWriteStream(partPath, { flags: "w" });
        await pipeline(res.body, fileStream);
    } else {
        throw new Error(`Unexpected status: ${res.status}`);
    }

    await fsp.rename(partPath, targetPath);
    await fsp.rm(metaPath, { force: true });
}

async function getPartMeta(metaPath) {
    try {
        return JSON.parse(await fsp.readFile(metaPath, "utf8"));
    } catch {
        return {};
    }
}

async function savePartMeta(metaPath, meta) {
    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
}

async function downloadFile(url, targetPath) {
    const tmpPath = `${targetPath}.part`;

    const res = await fetch(url, {
        redirect: "follow",
        headers: {
            "user-agent": "Mozilla/5.0 (Node.js downloader)",
        },
    });

    if (!res.ok || !res.body) {
        throw new Error(`GET failed: ${res.status} ${res.statusText}`);
    }

    await pipeline(res.body, fs.createWriteStream(tmpPath));
    await fsp.rename(tmpPath, targetPath);
}

async function fetchListing() {
    const res = await fetch(BASE_URL, {
        redirect: "follow",
        headers: {
            "user-agent": "Mozilla/5.0 (Node.js downloader)",
        },
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch listing: ${res.status} ${res.statusText}`);
    }

    return await res.text();
}

async function runWorker(queue, workerId) {
    while (queue.length > 0) {
        const item = queue.shift();
        if (!item) return;

        const name = fileNameFromUrl(item.url);
        const outPath = path.join(TARGET_DIR, name);

        try {
            const remoteSize = await getRemoteSize(item.url);

            if (await shouldSkip(outPath, remoteSize)) {
                console.log(`[${workerId}] skip  ${name}`);
                continue;
            }

            console.log(`[${workerId}] dl    ${name}`);
            await downloadFile(item.url, outPath);

            const stat = await fsp.stat(outPath);
            console.log(`[${workerId}] done  ${name} (${stat.size} bytes)`);
        } catch (err) {
            console.error(`[${workerId}] err   ${name}: ${err.message}`);
        }
    }
}

async function main() {
    await ensureDir(TARGET_DIR);

    console.log(`Listing: ${BASE_URL}`);
    console.log(`Target:  ${TARGET_DIR}`);
    console.log(`Workers: ${CONCURRENCY}`);

    const html = await fetchListing();
    const fileUrls = extractFileLinks(html, BASE_URL);

    console.log(`Found ${fileUrls.length} files`);

    if (fileUrls.length === 0) {
        const debugPath = path.join(TARGET_DIR, "_listing_debug.html");
        await fsp.writeFile(debugPath, html, "utf8");
        throw new Error(`No downloadable files found. Saved HTML to ${debugPath}`);
    }

    const queue = fileUrls.map((url) => ({ url }));
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => runWorker(queue, i + 1)));

    console.log("Finished");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
