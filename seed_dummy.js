const mongoose = require('mongoose');
const User = require('./models/User');
const Series = require('./models/Series');
const Video = require('./models/Video');

const MONGODB_URI = 'mongodb+srv://akshaysuresh968_db_user:bv9XuxQfsxo4D57p@cluster0.iqotult.mongodb.net/?retryWrites=true&w=majority';

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to DB');

  let admin = await User.findOne({ role: 'admin' });
  if (!admin) {
    admin = await User.create({
      username: 'Admin User',
      email: 'admin@example.com',
      password: 'password123',
      role: 'admin'
    });
    console.log('Created dummy admin user');
  }

  const dummySeries = await Series.create({
    title: 'The Great Antigravity Adventure',
    description: 'A cinematic masterpiece showing how a dummy series can be perfectly grouped with multiple seasons and episodes.',
    category: 'Action',
    language: 'English',
    totalEpisodes: 3,
    thumbnailUrl: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&q=80&w=800',
    creator: admin._id
  });
  console.log('Created dummy series');

  const ep1 = await Video.create({
    title: 'The First Encounter',
    description: 'Our journey begins.',
    category: 'Action',
    videoUrl: 'https://sample-videos.com/video123/mp4/720/big_buck_bunny_720p_1mb.mp4',
    thumbnailUrl: 'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&q=80&w=800',
    type: 'Episode',
    seriesId: dummySeries._id,
    seasonNumber: 1,
    episodeNumber: 1,
    creator: admin._id
  });

  const ep2 = await Video.create({
    title: 'The Plot Thickens',
    description: 'Danger lurks around every corner.',
    category: 'Action',
    videoUrl: 'https://sample-videos.com/video123/mp4/720/big_buck_bunny_720p_1mb.mp4',
    thumbnailUrl: 'https://images.unsplash.com/photo-1478720568477-152d9b164e26?auto=format&fit=crop&q=80&w=800',
    type: 'Episode',
    seriesId: dummySeries._id,
    seasonNumber: 1,
    episodeNumber: 2,
    creator: admin._id
  });

  const ep3 = await Video.create({
    title: 'A New Era (Season 2)',
    description: 'A new season brings new enemies.',
    category: 'Action',
    videoUrl: 'https://sample-videos.com/video123/mp4/720/big_buck_bunny_720p_1mb.mp4',
    thumbnailUrl: 'https://images.unsplash.com/photo-1626814026160-2237a95fc5a0?auto=format&fit=crop&q=80&w=800',
    type: 'Episode',
    seriesId: dummySeries._id,
    seasonNumber: 2,
    episodeNumber: 1,
    creator: admin._id
  });

  console.log('Created 3 episodes (Season 1 Episode 1, Season 1 Episode 2, Season 2 Episode 1)');
  console.log('Dummy Data Seeding Complete!');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
