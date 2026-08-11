import 'dotenv/config';
import { SchwabAuth } from './src/schwabAuth.js';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query: string): Promise<string> => {
  return new Promise(resolve => rl.question(query, resolve));
};

async function main() {
  console.log('=== Schwab API Test Script ===');
  
  if (!process.env.SCHWAB_CLIENT_ID || !process.env.SCHWAB_CLIENT_SECRET) {
    console.error('❌ Missing SCHWAB_CLIENT_ID or SCHWAB_CLIENT_SECRET in .env');
    console.log('Please copy .env.example to .env and fill in your app credentials.');
    process.exit(1);
  }

  const auth = new SchwabAuth();
  
  let accessToken = await auth.getValidAccessToken();

  if (!accessToken) {
    console.log('\n⚠️ No valid access token found. We need to authenticate.');
    console.log('\n1. Please click this link to authenticate with Schwab:');
    console.log('\x1b[36m%s\x1b[0m', auth.getAuthUrl());
    
    console.log('\n2. Log in and accept the terms.');
    console.log('3. Your browser will redirect to a URL that starts with https://127.0.0.1 (it may say "This site can\'t be reached").');
    console.log('4. Copy the ENTIRE URL from your address bar and paste it below:');
    
    const redirectedUrl = await askQuestion('\nPaste the URL here: ');
    
    let code = redirectedUrl;
    // Extract code if they pasted the full URL
    if (redirectedUrl.includes('code=')) {
      try {
        const urlObj = new URL(redirectedUrl);
        code = urlObj.searchParams.get('code') || redirectedUrl;
        // The code returned by Schwab often needs to be URI decoded if it has %40
        // URLSearchParams usually decodes it, but let's be careful.
      } catch (e) {
        // Not a valid URL, maybe they just pasted the code directly
      }
    } else if (redirectedUrl.includes('%40')) {
      // Just to be safe if they copied raw string
      code = decodeURIComponent(redirectedUrl);
    }
    
    code = code.trim();

    console.log('\nExchanging code for tokens...');
    try {
      await auth.getAccessTokenFromCode(code);
      console.log('✅ Successfully authenticated and saved tokens!');
      accessToken = await auth.getValidAccessToken();
    } catch (e) {
      console.error('❌ Failed to authenticate:', e);
      process.exit(1);
    }
  } else {
    console.log('✅ Found existing valid access token.');
  }

  console.log('\n=== Testing API Call (Options Chain for AAPL) ===');
  
  try {
    const symbol = 'AAPL';
    const response = await fetch(`https://api.schwabapi.com/marketdata/v1/chains?symbol=${symbol}&contractType=ALL&strikeCount=2`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API Error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    console.log(`✅ Successfully fetched options chain for ${symbol}`);
    console.log('Underlying Price:', data.underlyingPrice);
    
    const callExpDates = Object.keys(data.callExpDateMap || {});
    if (callExpDates.length > 0) {
      const firstExp = callExpDates[0];
      const strikes = Object.keys(data.callExpDateMap[firstExp]);
      console.log(`First Expiration: ${firstExp}`);
      console.log(`Number of strikes in this expiration: ${strikes.length}`);
      if (strikes.length > 0) {
        const sampleOption = data.callExpDateMap[firstExp][strikes[0]][0];
        console.log('Sample Call Option:');
        console.log(`  Symbol: ${sampleOption.symbol}`);
        console.log(`  Bid: ${sampleOption.bid} | Ask: ${sampleOption.ask} | Vol: ${sampleOption.totalVolume}`);
      }
    } else {
      console.log('No calls returned in the chain map.');
    }
    
  } catch (e) {
    console.error('❌ API call failed:', e);
  }

  rl.close();
}

main();
