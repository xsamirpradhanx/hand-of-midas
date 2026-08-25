import os
import sys
import gzip
import json
import boto3
from datetime import datetime, date, timedelta
from thetadata import ThetaClient

# Constants
S3_BUCKET = os.environ.get("S3_OPTIONS_BUCKET", "handofmidas-options-history")
REGION = "us-east-2"

def get_theta_api_key():
    try:
        ssm = boto3.client('ssm', region_name=REGION)
        resp = ssm.get_parameter(Name="/handofmidas/thetadata-api-key", WithDecryption=True)
        return resp['Parameter']['Value']
    except Exception as e:
        print(f"Error fetching API key from SSM: {e}")
        return None

def main():
    symbol = os.environ.get("SYMBOL")
    start_date_str = os.environ.get("START_DATE")
    end_date_str = os.environ.get("END_DATE")

    if not symbol or not start_date_str or not end_date_str:
        print("Usage: SYMBOL=AAPL START_DATE=YYYY-MM-DD END_DATE=YYYY-MM-DD python3 backfillHistoricalOptions.py")
        sys.exit(1)

    start_date = datetime.strptime(start_date_str, "%Y-%m-%d").date()
    end_date = datetime.strptime(end_date_str, "%Y-%m-%d").date()

    if start_date > end_date:
        print("START_DATE must be <= END_DATE")
        sys.exit(1)

    api_key = os.environ.get("THETA_API_KEY") or get_theta_api_key()
    if not api_key:
        print("Missing ThetaData API key.")
        sys.exit(1)

    print(f"Initializing ThetaClient...")
    client = ThetaClient(api_key=api_key)
    s3 = boto3.client('s3', region_name=REGION)

    print(f"Fetching {symbol} expirations...")
    try:
        expirations_df = client.option_list_expirations(symbol)
        expirations = expirations_df.get_column("expiration").to_list()
    except Exception as e:
        print(f"Failed to fetch expirations for {symbol}: {e}")
        sys.exit(1)

    # Filter expirations to only include those that were active between start_date and end_date + 45 days
    # (We only care about expirations that were reasonably near term on the dates we are backfilling)
    valid_expirations = []
    max_valid_exp = end_date + timedelta(days=90)
    for exp_str in expirations:
        exp_d = datetime.strptime(exp_str, "%Y-%m-%d").date()
        if exp_d >= start_date and exp_d <= max_valid_exp:
            valid_expirations.append(exp_d)

    print(f"Found {len(valid_expirations)} relevant expirations for the requested window.")

    current_date = start_date
    while current_date <= end_date:
        # Skip weekends
        if current_date.weekday() >= 5:
            current_date += timedelta(days=1)
            continue

        print(f"[{current_date}] Fetching chains...")
        
        try:
            # Fetch ALL expirations and strikes for the date in a single massive API call
            df = client.option_history_eod(current_date, current_date, symbol, "*", strike='*', right='both')
            
            if df.shape[0] > 0:
                records = df.to_dicts()
                # Filter locally to only include expirations within 60 days
                max_valid_exp = current_date + timedelta(days=60)
                daily_contracts = []
                for r in records:
                    exp_date = datetime.strptime(r["expiration"], "%Y-%m-%d").date()
                    if current_date <= exp_date <= max_valid_exp:
                        daily_contracts.append(r)
            else:
                daily_contracts = []
        except Exception as e:
            # Usually means no data found for that specific date.
            daily_contracts = []
            print(f"[{current_date}] Failed or no data: {e}")

        if len(daily_contracts) > 0:
            print(f"[{current_date}] Captured {len(daily_contracts)} contracts.")
            
            # Reformat to match our S3 json structure expected by OptionsStore
            formatted_chain = {
                "underlying_ticker": symbol,
                "date": current_date.strftime("%Y-%m-%d"),
                "contracts": []
            }
            
            for row in daily_contracts:
                # Map ThetaData fields to our expected Polygon-ish schema used in S3
                c = {
                    "details": {
                        "contract_type": "call" if row.get("right") == "C" else "put",
                        "expiration_date": row.get("expiration"),
                        "strike_price": row.get("strike")
                    },
                    "day": {
                        "close": row.get("close") or row.get("ask") or row.get("bid"), # Use close, fallback to ask/bid
                        "volume": row.get("volume", 0),
                        "open_interest": row.get("open_interest", 0)
                    },
                    "implied_volatility": row.get("implied_vol", 0),
                    "greeks": {
                        "delta": row.get("delta", 0),
                        "gamma": row.get("gamma", 0),
                        "theta": row.get("theta", 0),
                        "vega": row.get("vega", 0)
                    }
                }
                formatted_chain["contracts"].append(c)

            json_data = json.dumps(formatted_chain)
            compressed_data = gzip.compress(json_data.encode('utf-8'))
            
            s3_key = f"options/{symbol}/{current_date.strftime('%Y-%m-%d')}.json.gz"
            s3.put_object(
                Bucket=S3_BUCKET,
                Key=s3_key,
                Body=compressed_data,
                ContentType="application/json",
                ContentEncoding="gzip"
            )
            print(f"[{current_date}] Uploaded {s3_key}")
        else:
            print(f"[{current_date}] No contracts found. Skipping upload.")

        current_date += timedelta(days=1)

    print(f"Backfill complete for {symbol}.")

if __name__ == "__main__":
    main()
