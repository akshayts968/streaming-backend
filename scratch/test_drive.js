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

async function testMetadata() {
    try {
        const res = await drive.files.list({
            q: "trashed=false and mimeType contains 'video/'",
            fields: 'files(id, name, videoMediaMetadata)',
            pageSize: 5
        });
        console.log(JSON.stringify(res.data.files, null, 2));
    } catch (err) {
        console.error('Drive API Error:', err.message);
    }
}

testMetadata();
