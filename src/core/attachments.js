import { dirname, extname } from 'node:path';
import {
    existsSync, statSync, readFileSync, writeFileSync, mkdirSync, renameSync,
} from 'node:fs';
import { resolveVaultPath } from './note-fs.js';

export const MAX_READ_BYTES = 10_000_000; // S012/S009 default; config.js carries the real override

const MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.heic': 'image/heic',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeTypeFor(filePath) {
    return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function resolveAttachmentPath(vaultRoot, attachmentPath) {
    const filePath = resolveVaultPath(vaultRoot, attachmentPath);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        throw new Error(`Attachment not found: "${attachmentPath}"`);
    }
    return filePath;
}

export function readAttachment(vaultRoot, attachmentPath, {
    includeContent = true, maxReadBytes = MAX_READ_BYTES,
} = {}) {
    const filePath = resolveAttachmentPath(vaultRoot, attachmentPath);
    const { size } = statSync(filePath);
    const mimeType = mimeTypeFor(filePath);

    if (!includeContent) {
        return { path: attachmentPath, size_bytes: size, mime_type: mimeType };
    }
    if (size > maxReadBytes) {
        throw new Error(
            `attachment_read: "${attachmentPath}" is ${size} bytes, exceeding the ${maxReadBytes}`
            + '-byte cap. Retry with include_content: false for metadata only.',
        );
    }
    return {
        path: attachmentPath, size_bytes: size, mime_type: mimeType, content: readFileSync(filePath),
    };
}

export function writeAttachment(vaultRoot, attachmentPath, buffer) {
    const filePath = resolveVaultPath(vaultRoot, attachmentPath);
    mkdirSync(dirname(filePath), { recursive: true });

    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, buffer);
    renameSync(tmpPath, filePath);

    return { path: attachmentPath, size_bytes: buffer.length, mime_type: mimeTypeFor(filePath) };
}
