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
app.use(cors());

// Request logger
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Set static folder for local uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Connect to Database
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  retryWrites: true,
})
  .then(() => console.log('MongoDB Connected...'))
  .catch(err => {
    console.error('CRITICAL: MongoDB Connection Failed. App will stay alive for testing but DB features will fail.');
    console.error(err.message);
  });

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/videos', require('./routes/videos'));
app.use('/api/user', require('./routes/user'));

app.get('/', (req, res) => {
  res.send('Antigravity Stream API is running...');
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
