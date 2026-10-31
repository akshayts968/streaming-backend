const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {}

const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');

// Load env vars
dotenv.config();

const app = express();

const path = require('path');

// Body parser
app.use(express.json());

// Enable CORS
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Request logger
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Set static folder for local uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// Connect to Database
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      retryWrites: true,
    });
    console.log('✅ MongoDB Connected Successfully');
    const { initTelegramListener } = require('./utils/telegram');
    initTelegramListener().catch(err => console.error('Telegram listener startup failed:', err.message));
  } catch (err) {
    console.error('❌ CRITICAL: MongoDB Connection Failed');
    console.error(`Error: ${err.message}`);
    console.log('Retrying connection in 5 seconds...');
    setTimeout(connectDB, 5000);
  }
};

connectDB();

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/videos', require('./routes/videos'));
app.use('/api/user', require('./routes/user'));
app.use('/api/series', require('./routes/series'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/v1/stream', require('./routes/stream'));

// Initialize BullMQ Background Workers
try {
  require('./workers/transcodeWorker');
  console.log('✅ BullMQ Transcode Worker initialized');
} catch (wErr) {
  console.warn('⚠️ Transcode Worker initialization notice:', wErr.message);
}

app.get('/', (req, res) => {
  res.send('Antigravity Stream API is running...');
});

// Temp: One-time admin promotion route
app.get('/make-admin-now', async (req, res) => {
  try {
    const User = require('./models/User');
    const user = await User.findOneAndUpdate(
      { email: 'akshaysuresh968@gmail.com' },
      { role: 'admin' },
      { new: true }
    );
    if (user) {
      res.json({ success: true, message: `${user.email} is now ${user.role}. Please log out and log back in.` });
    } else {
      res.json({ success: false, message: 'User not found. Make sure you have registered with akshaysuresh968@gmail.com' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.get('/naina', (req, res) => {
  res.status(200).send('OK');
});
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
