const validCategories = [
  'Action', 'Drama', 'Thriller', 'Comedy', 'Sci-Fi', 'Adventure', 
  'Horror', 'Romance', 'Animation', 'Documentary', 'Regional', 'Fantasy', 'Mystery', 'Crime', 'Other'
];

/**
 * Robust extraction of title, year, and episode status from raw filename
 */
const extractTitleAndYear = (raw = '') => {
  let clean = raw.replace(/\.[^/.]+$/, '').trim();

  // 1. Extract year if present (handle both "(2025)" and "2025)" patterns)
  let year = null;
  const yearMatch = clean.match(/(?:[\s\.\(\[\-_])((?:19|20)\d{2})(?:[\s\.\)\]\-_]|$)/) ||
                    clean.match(/\s((?:19|20)\d{2})\)/);
  if (yearMatch) {
    year = yearMatch[1];
  }

  // 2. Detect series episode
  const epMatch = clean.match(/^(.*?)(?:[\s\.\-_]+(?:S\d+|Season\s*\d+|\d+x\d+))/i);
  if (epMatch) {
    let sTitle = epMatch[1].replace(/[\._]/g, ' ').replace(/\b\d{4}\b/g, '').trim();
    sTitle = sTitle.replace(/[-–—]+$/, '').trim();
    return { title: sTitle, year, isEpisode: true };
  }

  // 3. For movies, split before release metadata tags
  const tagsRegex = /(?:[\s\.\-_]+(?:(?:19|20)\d{2}|1080p|720p|480p|4k|2160p|ds4k|web-?dl|webrip|web|bluray|bdrip|brrip|dvdrip|hdtv|hdrip|remux|tamil|telugu|hindi|malayalam|kannada|english|dual\s*audio|multi|true|proper|repack|x265|x264|h265|h264|hevc|avc|10bit|8bit|dd\+?|aac|ac3|dts|atmos|e-?sub|esub))/i;
  const match = clean.split(tagsRegex)[0];
  let title = (match || clean).replace(/[\._]/g, ' ').replace(/[-–—]+$/, '').trim();
  title = title.replace(/\s+-\s+.*$/, '').replace(/[-_]+$/, '').trim();

  return { title, year, isEpisode: false };
};

/**
 * Map raw genres/categories into supported Antigravity category enums
 */
const mapGenresToCategories = (genres = []) => {
  const list = Array.isArray(genres) ? genres : (genres ? String(genres).split(',') : []);
  const matched = [];

  for (const raw of list) {
    const trimmed = raw.trim().toLowerCase();
    for (const valid of validCategories) {
      if (valid.toLowerCase() === trimmed || trimmed.includes(valid.toLowerCase())) {
        if (!matched.includes(valid)) matched.push(valid);
      }
    }
  }

  if (matched.length === 0) matched.push('Drama');
  return matched;
};

/**
 * Fetch series metadata from TVMaze
 */
const fetchSeriesFromTVMaze = async (seriesName, seasonNum = 1, episodeNum = 1) => {
  try {
    const cleanName = seriesName.replace(/\b\d{4}\b/g, '').trim();
    const searchUrl = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(cleanName || seriesName)}`;
    const res = await fetch(searchUrl, { headers: { 'User-Agent': 'AntigravityStream/1.0' } });
    if (!res.ok) return null;

    const results = await res.json();
    if (!results || results.length === 0) return null;

    const show = results[0].show;
    let episodeData = null;
    let totalEpisodes = 1;

    try {
      const epRes = await fetch(`https://api.tvmaze.com/shows/${show.id}/episodes`, { headers: { 'User-Agent': 'AntigravityStream/1.0' } });
      if (epRes.ok) {
        const episodes = await epRes.json();
        totalEpisodes = episodes.length || 1;
        episodeData = episodes.find(e => e.season === seasonNum && e.number === episodeNum);
      }
    } catch (e) {}

    const showPoster = show.image?.original || show.image?.medium || null;
    const epPoster = episodeData?.image?.original || episodeData?.image?.medium || showPoster;

    const epSummary = episodeData?.summary
      ? episodeData.summary.replace(/<[^>]*>/g, '').trim()
      : (show.summary ? show.summary.replace(/<[^>]*>/g, '').trim() : '');

    return {
      source: 'TVMaze',
      seriesTitle: show.name || seriesName,
      episodeTitle: episodeData?.name || `Episode ${episodeNum}`,
      seasonNumber: seasonNum,
      episodeNumber: episodeNum,
      totalEpisodes: Math.max(totalEpisodes, episodeNum),
      category: mapGenresToCategories(show.genres),
      description: epSummary,
      posterUrl: epPoster,
      showPoster: showPoster,
      showRating: show.rating?.average || null
    };
  } catch (err) {
    return null;
  }
};

/**
 * Fetch movie or series episode from OMDb API with multi-fallback search
 */
const fetchFromOMDb = async ({ title, year, seriesTitle, seasonNumber, episodeNumber, isEpisode }) => {
  const apiKey = process.env.OMDB_API_KEY || 'trilogy';

  try {
    if (isEpisode) {
      const targetSeries = seriesTitle || title;
      const url = `http://www.omdbapi.com/?t=${encodeURIComponent(targetSeries)}&Season=${seasonNumber || 1}&Episode=${episodeNumber || 1}&apikey=${apiKey}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data && data.Response !== 'False') {
          return {
            source: 'OMDb',
            seriesTitle: targetSeries,
            episodeTitle: data.Title || `Episode ${episodeNumber || 1}`,
            seasonNumber: seasonNumber || 1,
            episodeNumber: episodeNumber || 1,
            category: mapGenresToCategories(data.Genre),
            description: data.Plot !== 'N/A' ? data.Plot : '',
            posterUrl: data.Poster && data.Poster !== 'N/A' ? data.Poster : null,
            year: data.Year
          };
        }
      }

      // Fallback: search series main page
      const sUrl = `http://www.omdbapi.com/?t=${encodeURIComponent(targetSeries)}&apikey=${apiKey}`;
      const sRes = await fetch(sUrl);
      if (sRes.ok) {
        const sData = await sRes.json();
        if (sData && sData.Response !== 'False') {
          return {
            source: 'OMDb',
            seriesTitle: sData.Title || targetSeries,
            episodeTitle: `Episode ${episodeNumber || 1}`,
            seasonNumber: seasonNumber || 1,
            episodeNumber: episodeNumber || 1,
            totalEpisodes: parseInt(sData.totalSeasons, 10) || 1,
            category: mapGenresToCategories(sData.Genre),
            description: sData.Plot !== 'N/A' ? sData.Plot : '',
            posterUrl: sData.Poster && sData.Poster !== 'N/A' ? sData.Poster : null,
            year: sData.Year
          };
        }
      }
      return null;
    }

    // 1. Direct title + year search
    if (year) {
      const urlWithYear = `http://www.omdbapi.com/?t=${encodeURIComponent(title)}&y=${year}&apikey=${apiKey}`;
      const res = await fetch(urlWithYear);
      if (res.ok) {
        const data = await res.json();
        if (data && data.Response !== 'False') {
          return {
            source: 'OMDb / IMDb',
            title: data.Title || title,
            category: mapGenresToCategories(data.Genre),
            description: data.Plot !== 'N/A' ? data.Plot : '',
            posterUrl: data.Poster && data.Poster !== 'N/A' ? data.Poster : null,
            year: data.Year,
            actors: data.Actors !== 'N/A' ? data.Actors : null,
            director: data.Director !== 'N/A' ? data.Director : null
          };
        }
      }
    }

    // 2. Direct title search without year
    const urlTitle = `http://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${apiKey}`;
    const resTitle = await fetch(urlTitle);
    if (resTitle.ok) {
      const data = await resTitle.json();
      if (data && data.Response !== 'False') {
        return {
          source: 'OMDb / IMDb',
          title: data.Title || title,
          category: mapGenresToCategories(data.Genre),
          description: data.Plot !== 'N/A' ? data.Plot : '',
          posterUrl: data.Poster && data.Poster !== 'N/A' ? data.Poster : null,
          year: data.Year,
          actors: data.Actors !== 'N/A' ? data.Actors : null,
          director: data.Director !== 'N/A' ? data.Director : null
        };
      }
    }

    // 3. OMDb Search endpoint (?s=...) with ID resolution
    const searchUrl = `http://www.omdbapi.com/?s=${encodeURIComponent(title)}&apikey=${apiKey}`;
    const searchRes = await fetch(searchUrl);
    if (searchRes.ok) {
      const sData = await searchRes.json();
      if (sData && sData.Search && sData.Search.length > 0) {
        // match year if available, otherwise pick first
        let best = sData.Search[0];
        if (year) {
          const matchYear = sData.Search.find(item => item.Year === year);
          if (matchYear) best = matchYear;
        }

        const idRes = await fetch(`http://www.omdbapi.com/?i=${best.imdbID}&apikey=${apiKey}`);
        if (idRes.ok) {
          const idData = await idRes.json();
          if (idData && idData.Response !== 'False') {
            return {
              source: 'OMDb / IMDb',
              title: idData.Title || title,
              category: mapGenresToCategories(idData.Genre),
              description: idData.Plot !== 'N/A' ? idData.Plot : '',
              posterUrl: idData.Poster && idData.Poster !== 'N/A' ? idData.Poster : null,
              year: idData.Year,
              actors: idData.Actors !== 'N/A' ? idData.Actors : null,
              director: idData.Director !== 'N/A' ? idData.Director : null
            };
          }
        }
      }
    }

    return null;
  } catch (err) {
    return null;
  }
};

/**
 * Intelligent unified metadata search from internet:
 * Automatically called when video is forwarded or uploaded in Telegram!
 */
const fetchVideoMetadata = async ({ rawFileName = '', text = '', isEpisode = false, seriesTitle = '', seasonNumber = 1, episodeNumber = 1 }) => {
  const extracted = extractTitleAndYear(rawFileName);
  // Strictly honor explicit boolean isEpisode parameter if passed
  const detectedIsEp = typeof isEpisode === 'boolean' ? isEpisode : extracted.isEpisode;
  
  // Clean text from m/s type flags if user passed caption with flag
  const cleanCaption = text ? text.replace(/(?:^|\s)[ms](?:\s|$)/gi, ' ').replace(/\b(movie|film|series|show|tv)\b/gi, ' ').trim() : '';
  // Only use caption as title if it's SHORT and doesn't look like Telegram spam/forwarding text
  const captionLooksLikeTitle = cleanCaption && cleanCaption.length > 1 && cleanCaption.length < 60 &&
    !/file will be deleted|PLEASE FORWARD|t\.me\/|join this channel|forward file|saved message|contacts/i.test(cleanCaption);
  const targetTitle = seriesTitle || (captionLooksLikeTitle && !detectedIsEp ? cleanCaption : null) || extracted.title || rawFileName;
  const targetYear = extracted.year;

  if (detectedIsEp) {
    // 1. Try TVMaze first for TV Series
    const tvMazeData = await fetchSeriesFromTVMaze(targetTitle, seasonNumber, episodeNumber);
    if (tvMazeData) {
      return {
        found: true,
        type: 'Episode',
        title: `${tvMazeData.seriesTitle} - S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}: ${tvMazeData.episodeTitle}`,
        episodeTitle: tvMazeData.episodeTitle,
        seriesTitle: tvMazeData.seriesTitle,
        seasonNumber: tvMazeData.seasonNumber,
        episodeNumber: tvMazeData.episodeNumber,
        totalEpisodes: tvMazeData.totalEpisodes,
        category: tvMazeData.category,
        description: tvMazeData.description,
        posterUrl: tvMazeData.posterUrl,
        source: 'TVMaze'
      };
    }

    // 2. Try OMDb for TV Series
    const omdbData = await fetchFromOMDb({ title: targetTitle, seriesTitle: targetTitle, seasonNumber, episodeNumber, isEpisode: true });
    if (omdbData) {
      return {
        found: true,
        type: 'Episode',
        title: `${omdbData.seriesTitle} - S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}: ${omdbData.episodeTitle}`,
        episodeTitle: omdbData.episodeTitle,
        seriesTitle: omdbData.seriesTitle,
        seasonNumber: omdbData.seasonNumber,
        episodeNumber: omdbData.episodeNumber,
        totalEpisodes: omdbData.totalEpisodes || 1,
        category: omdbData.category,
        description: omdbData.description,
        posterUrl: omdbData.posterUrl,
        source: 'OMDb / IMDb'
      };
    }

    return {
      found: false,
      type: 'Episode',
      title: `${targetTitle} S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`,
      episodeTitle: `Episode ${episodeNumber}`,
      seriesTitle: targetTitle,
      seasonNumber,
      episodeNumber,
      category: ['Drama'],
      description: '',
      posterUrl: null,
      source: 'Filename'
    };
  }

  // Movie search on OMDb
  const omdbMovie = await fetchFromOMDb({ title: targetTitle, year: targetYear, isEpisode: false });
  if (omdbMovie) {
    return {
      found: true,
      type: 'Movie',
      title: omdbMovie.title,
      category: omdbMovie.category,
      description: omdbMovie.description,
      posterUrl: omdbMovie.posterUrl,
      year: omdbMovie.year,
      actors: omdbMovie.actors,
      director: omdbMovie.director,
      source: omdbMovie.source || 'OMDb / IMDb'
    };
  }

  // Fallback if not found
  return {
    found: false,
    type: 'Movie',
    title: targetTitle,
    category: ['Action'],
    description: '',
    posterUrl: null,
    source: 'Filename'
  };
};

module.exports = {
  fetchVideoMetadata,
  extractTitleAndYear,
  mapGenresToCategories
};
