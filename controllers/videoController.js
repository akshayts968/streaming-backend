const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// Initialize Drive API with OAuth2
const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
);

oauth2Client.setCredentials({
    refresh_token: process.env.REFRESH_TOKEN
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

const streamVideo = async (req, res) => {
    const fileId = req.params.fileId;
    const range = req.headers.range;

    if (!range) return res.status(400).json({ error: "Requires Range header" });

    try {
        const fileMetadata = await drive.files.get({ fileId: fileId, fields: 'size', supportsAllDrives: true });
        const videoSize = Number(fileMetadata.data.size);

        const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks for smoother streaming
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = Math.min(start + CHUNK_SIZE, videoSize - 1);
        const contentLength = end - start + 1;

        const headers = {
            "Content-Range": `bytes ${start}-${end}/${videoSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": contentLength,
            "Content-Type": "video/mp4",
        };
        
        res.writeHead(206, headers);

        const driveStream = await drive.files.get(
            { fileId: fileId, alt: 'media' },
            { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
        );

        driveStream.data.on('error', (err) => {
            console.error("Stream error:", err);
            if (!res.headersSent) res.status(500).end();
        }).pipe(res);

    } catch (error) {
        console.error("Drive API Stream Error:", error.message);
        if (!res.headersSent) res.status(500).json({ error: `Drive Stream Failed: ${error.message}` });
    }
};

const uploadVideoToDrive = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Please upload a video file' });
        }

        const { title, description, category, tags } = req.body;
        const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID; // Optional shared folder ID

        console.log(`Starting Drive upload for: ${req.file.originalname}`);

        // Variables for calculating speed and percentage
        const fileSize = req.file.size;
        let lastLoggedTime = Date.now();
        let lastBytesRead = 0;

        // Create file on Google Drive using Resumable Upload
        const response = await drive.files.create({
            requestBody: {
                name: req.file.originalname,
                mimeType: req.file.mimetype,
                parents: folderId ? [folderId] : [] // Upload to specific folder if provided
            },
            media: {
                mimeType: req.file.mimetype,
                body: fs.createReadStream(req.file.path),
            },
            supportsAllDrives: true,
        }, {
            onUploadProgress: (evt) => {
                const now = Date.now();
                const timeElapsed = (now - lastLoggedTime) / 1000; // in seconds

                if (timeElapsed >= 1 || evt.bytesRead === fileSize) {
                    const percent = Math.min(Math.round((evt.bytesRead / fileSize) * 100), 100);
                    const bytesSinceLast = evt.bytesRead - lastBytesRead;
                    const speed = bytesSinceLast / timeElapsed; // bytes per sec
                    const speedMBps = (speed / (1024 * 1024)).toFixed(2);
                    const uploadedMB = (evt.bytesRead / (1024 * 1024)).toFixed(2);
                    const totalMB = (fileSize / (1024 * 1024)).toFixed(2);

                    process.stdout.write(`\r[Upload Progress] ${percent}% | Speed: ${speedMBps} MB/s | Transferred: ${uploadedMB} MB / ${totalMB} MB   `);

                    lastLoggedTime = now;
                    lastBytesRead = evt.bytesRead;
                }
            }
        });

        console.log(''); // Print newline after progress finishes

        const driveFileId = response.data.id;
        console.log(`Upload Successful. File ID: ${driveFileId}`);

        // Clean up local temp file
        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        // Save to Database
        const Video = require('../models/Video');
        const video = await Video.create({
            title,
            description,
            category,
            tags: tags ? tags.split(',') : [],
            videoUrl: `PROXIED_DRIVE_${driveFileId}`,
            drive_file_id: driveFileId,
            creator: req.user.id,
            thumbnailUrl: req.body.thumbnailUrl || 'no-thumbnail.jpg'
        });

        res.status(201).json({
            success: true,
            data: video
        });
    } catch (error) {
        console.error("Drive Upload Error Detailed:", error);
        
        // Cleanup temp file even on error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({ 
            success: false, 
            error: `Drive Upload Failed: ${error.message}`,
            details: error.response?.data || "No extra details"
        });
    }
};

const uploadVideoToCloudinary = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Please upload a video file' });
        }

        const { title, description, category, tags } = req.body;
        console.log(`Starting Cloudinary upload for: ${req.file.originalname}`);

        const { uploadVideo } = require('../utils/cloudinary');
        const uploadResult = await uploadVideo(req.file.path);

        console.log(`Upload Successful. Cloudinary URL: ${uploadResult.secure_url}`);

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        const Video = require('../models/Video');
        const video = await Video.create({
            title,
            description,
            category,
            tags: tags ? tags.split(',') : [],
            videoUrl: uploadResult.secure_url,
            drive_file_id: '', // Empty because it's not on Drive anymore
            creator: req.user.id,
            thumbnailUrl: req.body.thumbnailUrl || 'no-thumbnail.jpg'
        });

        res.status(201).json({ success: true, data: video });
    } catch (error) {
        console.error("Cloudinary Upload Error:", error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: `Cloudinary Upload Failed: ${error.message}` });
    }
};

const activeUploads = new Map();

const uploadChunkToDrive = async (req, res) => {
    try {
        const { uploadId, chunkIndex, totalChunks, totalSize, title, description, category, tags, thumbnailUrl } = req.body;
        const chunk = req.file;

        if (!chunk) return res.status(400).json({ success: false, message: 'No chunk received' });

        let uploadData = activeUploads.get(uploadId);

        // Step 1: Initialize Resumable Session
        if (!uploadData && parseInt(chunkIndex) === 0) {
            console.log(`\n[Drive] Starting Resumable Upload for: ${title}`);
            
            const { token } = await oauth2Client.getAccessToken();
            const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

            const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'X-Upload-Content-Type': 'video/mp4',
                    'X-Upload-Content-Length': totalSize
                },
                body: JSON.stringify({
                    name: `${title || 'Video'}.mp4`,
                    parents: folderId ? [folderId] : []
                })
            });

            if (!initRes.ok) throw new Error(`Drive Session Init Failed: ${await initRes.text()}`);

            const sessionUrl = initRes.headers.get('location');
            uploadData = { sessionUrl, bytesSent: 0, startTime: Date.now() };
            activeUploads.set(uploadId, uploadData);
        }

        if (!uploadData) {
            if (fs.existsSync(chunk.path)) fs.unlinkSync(chunk.path);
            return res.status(400).json({ success: false, message: 'Upload session missing.' });
        }

        // Step 2: Forward Chunk
        const CHUNK_SIZE = 5 * 1024 * 1024;
        const startByte = parseInt(chunkIndex) * CHUNK_SIZE;
        const endByte = startByte + chunk.size - 1;

        const { token } = await oauth2Client.getAccessToken();
        
        const uploadRes = await fetch(uploadData.sessionUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Range': `bytes ${startByte}-${endByte}/${totalSize}`,
            },
            body: fs.createReadStream(chunk.path),
            duplex: 'half'
        });

        if (fs.existsSync(chunk.path)) fs.unlinkSync(chunk.path);

        if (uploadRes.status === 308 || uploadRes.ok) {
            // Update Telemetry
            uploadData.bytesSent += chunk.size;
            const now = Date.now();
            const timeElapsed = (now - uploadData.startTime) / 1000; // seconds
            const speed = uploadData.bytesSent / (timeElapsed || 1);
            const speedMBps = (speed / (1024 * 1024)).toFixed(2);
            const percent = Math.min(Math.round((uploadData.bytesSent / totalSize) * 100), 100);
            const uploadedMB = (uploadData.bytesSent / (1024 * 1024)).toFixed(2);
            const totalMB = (totalSize / (1024 * 1024)).toFixed(2);

            // Print progress line
            process.stdout.write(`\r[Drive Progress] ${percent}% | Speed: ${speedMBps} MB/s | ${uploadedMB} / ${totalMB} MB   `);

            if (uploadRes.ok && parseInt(chunkIndex) === parseInt(totalChunks) - 1) {
                // Final Chunk Done
                console.log('\n[Drive] Upload Complete. Finalizing...');
                const driveData = await uploadRes.json();
                activeUploads.delete(uploadId);

                const Video = require('../models/Video');
                const video = await Video.create({
                    title,
                    description,
                    category,
                    tags: tags ? tags.split(',') : [],
                    videoUrl: `PROXIED_DRIVE_${driveData.id}`,
                    drive_file_id: driveData.id,
                    creator: req.user.id,
                    thumbnailUrl: thumbnailUrl || 'no-thumbnail.jpg'
                });

                return res.status(201).json({ success: true, data: video });
            }

            return res.status(200).json({ success: true, message: `Chunk ${chunkIndex} synced` });
        } else {
            const err = await uploadRes.text();
            activeUploads.delete(uploadId);
            throw new Error(`Drive Upload Failed: ${err}`);
        }

    } catch (error) {
        console.error("\nChunk Upload Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
};

module.exports = { streamVideo, uploadVideoToDrive, uploadVideoToCloudinary, uploadChunkToDrive };
