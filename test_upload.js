const http = require('http');
const crypto = require('crypto');
const boundary = '----WebKitFormBoundaryDummy123';
const bodySegments = [];

bodySegments.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="title"\r\n\r\nTest Title\r\n'));
bodySegments.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="video"; filename="test.mp4"\r\nContent-Type: video/mp4\r\n\r\n'));
bodySegments.push(crypto.randomBytes(1024 * 1024)); // 1MB fake video
bodySegments.push(Buffer.from('\r\n--' + boundary + '--\r\n'));

const body = Buffer.concat(bodySegments);

const req = http.request({
  hostname: 'localhost',
  port: 5001,
  path: '/api/videos/upload-drive',
  method: 'POST',
  headers: {
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Content-Length': body.length,
    'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY5ZWY3OTRiMTlmYThkNDE3ZmQxZjI1NSIsInJvbGUiOiJ2aWV3ZXIiLCJpYXQiOjE3NzczMDE4MzUsImV4cCI6MTc3OTg5MzgzNX0.WHnP9LxDwhABBDMVQv_itymsjncb-7aLD3OI4L84hww'
  }
}, res => {
  console.log('STATUS:', res.statusCode);
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('RESPONSE:', data));
});

req.on('error', e => console.error('REQ_ERROR:', e.message));
req.write(body);
req.end();
