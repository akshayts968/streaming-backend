const http = require('http');
const crypto = require('crypto');
const boundary = '----WebKitFormBoundaryDummy123';

const req = http.request({
  hostname: 'localhost',
  port: 5001,
  path: '/api/videos/upload-drive',
  method: 'POST',
  headers: {
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY5ZWY3OTRiMTlmYThkNDE3ZmQxZjI1NSIsInJvbGUiOiJ2aWV3ZXIiLCJpYXQiOjE3NzczMDE4MzUsImV4cCI6MTc3OTg5MzgzNX0.WHnP9LxDwhABBDMVQv_itymsjncb-7aLD3OI4L84hww'
  }
}, res => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('STATUS:', res.statusCode, 'RESPONSE:', data));
});

req.on('error', e => console.error('REQ_ERROR:', e.message));

// Write text fields
req.write('--' + boundary + '\r\nContent-Disposition: form-data; name="title"\r\n\r\nTest Title\r\n');

// Write dummy JPEG
req.write('--' + boundary + '\r\nContent-Disposition: form-data; name="thumbnail"; filename="thumb.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
req.write(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]));
req.write('\r\n');

// Write dummy MP4
req.write('--' + boundary + '\r\nContent-Disposition: form-data; name="video"; filename="test.mp4"\r\nContent-Type: video/mp4\r\n\r\n');
req.write(crypto.randomBytes(1024 * 50)); // 50KB to be safe
req.write('\r\n--' + boundary + '--\r\n');

req.end();
