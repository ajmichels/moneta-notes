import { dirname, extname } from 'node:path';
import {
    existsSync, statSync, readFileSync, writeFileSync, mkdirSync, renameSync,
} from 'node:fs';
import { PDFDocument } from 'pdf-lib';
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

function validatePageRangeArgs(attachmentPath, isPdf, includeContent, startPage, endPage) {
    if (startPage === undefined && endPage === undefined) {
        return;
    }
    if (!isPdf) {
        throw new Error(
            `attachment_read: start_page/end_page are only valid for PDF attachments; `
            + `"${attachmentPath}" is not a PDF.`,
        );
    }
    if (startPage === undefined || endPage === undefined) {
        throw new Error('attachment_read: start_page and end_page must both be given together.');
    }
    if (includeContent === false) {
        throw new Error(
            'attachment_read: start_page/end_page cannot be combined with include_content: false.',
        );
    }
}

async function tryLoadPdf(buffer) {
    try {
        return await PDFDocument.load(buffer);
    } catch {
        return null; // best-effort: a corrupt/mislabeled "PDF" shouldn't block a plain byte/metadata read
    }
}

async function slicePdfPages(srcDoc, startPage, endPage) {
    const indices = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage - 1 + i);
    const sliceDoc = await PDFDocument.create();
    const copiedPages = await sliceDoc.copyPages(srcDoc, indices);
    copiedPages.forEach((page) => sliceDoc.addPage(page));
    return Buffer.from(await sliceDoc.save());
}

async function readPdfAttachment(attachmentPath, filePath, size, mimeType, {
    includeContent, maxReadBytes, startPage, endPage,
}) {
    const wantsPageRange = startPage !== undefined;
    const fileBuffer = readFileSync(filePath);
    // A page range needs a real, parseable PDF to slice — let a parse failure surface. Otherwise
    // total_pages is opportunistic, so a corrupt file still supports a plain byte/metadata read.
    const srcDoc = wantsPageRange ? await PDFDocument.load(fileBuffer) : await tryLoadPdf(fileBuffer);
    const totalPages = srcDoc ? srcDoc.getPageCount() : undefined;
    const totalPagesField = totalPages === undefined ? {} : { total_pages: totalPages };

    if (!includeContent) {
        return { path: attachmentPath, size_bytes: size, mime_type: mimeType, ...totalPagesField };
    }

    if (wantsPageRange) {
        if (startPage < 1 || endPage > totalPages || startPage > endPage) {
            throw new Error(
                `attachment_read: "${attachmentPath}" start_page/end_page must satisfy `
                + `1 <= start_page <= end_page <= total_pages (${totalPages}); got `
                + `start_page=${startPage}, end_page=${endPage}.`,
            );
        }
        const sliceBuffer = await slicePdfPages(srcDoc, startPage, endPage);
        if (sliceBuffer.length > maxReadBytes) {
            throw new Error(
                `attachment_read: "${attachmentPath}" pages ${startPage}-${endPage} are `
                + `${sliceBuffer.length} bytes, exceeding the ${maxReadBytes}-byte cap. Narrow the `
                + 'page range further.',
            );
        }
        return {
            path: attachmentPath, size_bytes: sliceBuffer.length, mime_type: mimeType,
            total_pages: totalPages, content: sliceBuffer,
        };
    }

    if (size > maxReadBytes) {
        throw new Error(
            `attachment_read: "${attachmentPath}" is ${size} bytes, exceeding the ${maxReadBytes}`
            + '-byte cap. Retry with include_content: false for metadata only'
            + (totalPages === undefined ? '.' : `, or start_page/end_page (1..${totalPages}) for a slice.`),
        );
    }
    return {
        path: attachmentPath, size_bytes: size, mime_type: mimeType, ...totalPagesField, content: fileBuffer,
    };
}

export async function readAttachment(vaultRoot, attachmentPath, {
    includeContent = true, maxReadBytes = MAX_READ_BYTES, startPage, endPage,
} = {}) {
    const filePath = resolveAttachmentPath(vaultRoot, attachmentPath);
    const { size } = statSync(filePath);
    const mimeType = mimeTypeFor(filePath);
    const isPdf = mimeType === 'application/pdf';

    validatePageRangeArgs(attachmentPath, isPdf, includeContent, startPage, endPage);

    if (isPdf) {
        return readPdfAttachment(attachmentPath, filePath, size, mimeType, {
            includeContent, maxReadBytes, startPage, endPage,
        });
    }

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
