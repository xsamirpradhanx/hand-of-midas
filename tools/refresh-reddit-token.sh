#!/bin/bash
# Refresh Reddit Devvit Token
# This script launches the Devvit CLI login flow to regenerate the 
# ~/.devvit/token used by the Hand of Midas Reddit Sentiment engine.

echo "========================================================="
echo "       Reddit Sentiment Token Refresher (Devvit)         "
echo "========================================================="
echo ""
echo "This will open your browser. Please log in to Reddit and authorize the CLI."
echo "Once complete, your token will be saved and the backend can access Reddit data."
echo ""

# The only command actually needed to get the token!
npx devvit login

echo ""
echo "========================================================="
echo "✅ Token successfully refreshed!"
echo "If your backend was running, the new token will be picked up on the next request."
echo "========================================================="
