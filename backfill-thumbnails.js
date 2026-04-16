const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');

async function main() {
    if (!fs.existsSync(HISTORY_PATH)) {
        process.stdout.write('No history file found, nothing to backfill.\n');
        return;
    }

    const history = readHistory();
    let updatedCount = 0;
    let skippedCount = 0;

    for (const record of history) {
        const userId = String(record.userId || '').trim();
        const imageUrl = String(record.imageUrl || '').trim();
        if (!userId || !imageUrl) {
            skippedCount += 1;
            continue;
        }

        const sourcePath = resolveStoredPath(imageUrl);
        if (!sourcePath.startsWith(USERS_DIR) || !fs.existsSync(sourcePath)) {
            skippedCount += 1;
            continue;
        }

        const existingThumb = String(record.thumbnailUrl || '').trim();
        if (existingThumb) {
            const existingThumbPath = resolveStoredPath(existingThumb);
            if (fs.existsSync(existingThumbPath) && existingThumbPath !== sourcePath) {
                skippedCount += 1;
                continue;
            }
        }

        const thumbFilename = `${path.parse(sourcePath).name}.jpg`;
        const thumbPath = path.join(USERS_DIR, userId, 'thumb', thumbFilename);
        fs.mkdirSync(path.dirname(thumbPath), { recursive: true });

        await createThumbnail(sourcePath, thumbPath);
        record.thumbnailUrl = `/image/users/${userId}/thumb/${thumbFilename}`;
        updatedCount += 1;
    }

    writeHistory(history);
    process.stdout.write(`Thumbnail backfill complete. Updated: ${updatedCount}, skipped: ${skippedCount}\n`);
}

function readHistory() {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
}

function writeHistory(records) {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(records, null, 2), 'utf8');
}

async function createThumbnail(input, outputPath) {
    await sharp(input)
        .rotate()
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 78, mozjpeg: true })
        .toFile(outputPath);
}

function resolveStoredPath(requestPath) {
    const normalized = path.normalize(String(requestPath || '').split('?')[0]).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/, '').replace(/\\/g, '/');
    if (normalized.startsWith('image/users/')) {
        const relative = normalized.slice('image/users/'.length);
        const parts = relative.split('/').filter(Boolean);
        const userId = parts.shift() || '';
        if (parts[0] === 'thumb') return path.join(USERS_DIR, userId, 'thumb', ...parts.slice(1));
        if (parts[0] === 'images') return path.join(USERS_DIR, userId, 'images', ...parts.slice(1));
        return path.join(USERS_DIR, userId, 'images', ...parts);
    }
    return path.join(ROOT_DIR, normalized);
}

main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
});
