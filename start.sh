#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed. Please install it from https://nodejs.org"
  exit 1
fi

echo "Installing dependencies..."
npm install --registry https://registry.npmjs.org

echo "Starting SpectoVoice..."
npm run dev
