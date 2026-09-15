#!/usr/bin/env node
import { generatePassportFiles, checkPassportFiles } from "./passport.js";
const args = process.argv.slice(2), command = args[0];
const value = (name: string): string => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) {throw new Error("PASSPORT_ARGUMENTS");} return args[i + 1]!; };
try {
  if (command === "generate") {await generatePassportFiles(value("--manifest"), value("--observations"), value("--output"));}
  else if (command === "check") {await checkPassportFiles(value("--manifest"), value("--observations"), value("--passport"), value("--registry"));}
  else {throw new Error("PASSPORT_ARGUMENTS");}
  process.stdout.write(`${JSON.stringify({ status: "verified", broadcastAllowed: false })}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ status: "invalid", reason: error instanceof Error ? error.message : "PASSPORT_FAILURE", broadcastAllowed: false })}\n`); process.exitCode = 2; }
