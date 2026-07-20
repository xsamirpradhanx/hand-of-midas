import { yf } from './src/services/yahoo.js'; yf.quote('AAPL').then(r => console.log(r.regularMarketPrice)).catch(console.error);
