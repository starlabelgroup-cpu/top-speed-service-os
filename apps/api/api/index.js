// Vercel serverless entry for the Top Speed Service OS API.
//
// Vercel turns this file into a function (see vercel.json in apps/api,
// which rewrites every path to it). The Express app is imported from
// src/server.js — importing it does NOT start the listener (that only
// happens when server.js is run directly, e.g. local `npm start`).
//
// The app itself is the handler. An earlier version wrapped it in an async
// function that awaited store hydration before calling the app — on Vercel
// that broke every request with a body (POST/PUT hung forever waiting for a
// request stream the runtime had already let flow past). Hydration now runs
// as middleware inside the Express pipeline (see src/server.js), where the
// request stream stays untouched until the body parsers run.
import app from '../src/server.js';

export default app;
