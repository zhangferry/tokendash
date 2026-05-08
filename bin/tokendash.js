#!/usr/bin/env node
import { main } from "../dist/server/index.js";
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
