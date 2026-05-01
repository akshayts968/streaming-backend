const { google } = require('googleapis');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
);

oauth2Client.setCredentials({
    refresh_token: process.env.REFRESH_TOKEN
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

async function testAllMetadata() {
    try {
        const res = await drive.files.get({
            fileId: '1g3LBYP8bp6wG79v_n7Q6rCKE0YRmsXiN',
            fields: '*',
            supportsAllDrives: true
        });
        console.log('VideoMediaMetadata:', res.data.videoMediaMetadata);
        console.log('MimeType:', res.data.mimeType);
    } catch (err) {
        console.error('Drive API Error:', err.message);
    }
}

testAllMetadata();
