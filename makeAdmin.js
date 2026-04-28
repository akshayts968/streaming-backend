const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');

dotenv.config();

async function makeAdmin() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/streaming');
    const user = await User.findOneAndUpdate(
      { email: 'akshaysuresh968@gmail.com' },
      { role: 'admin' },
      { new: true }
    );
    if (user) {
      console.log('Successfully made user admin:', user.email, 'Role:', user.role);
    } else {
      console.log('User not found. Please register first.');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    mongoose.disconnect();
  }
}

makeAdmin();
