// Generate the master mnemonic that derives every forecaster wallet, and write
// it to `.master` (gitignored, owner-read-only). Run once, before the first
// benchmark. Losing this file makes all derived wallets inaccessible.

import fs from "fs";
import path from "path";
import { ethers } from "ethers";

const MASTER_MNEMONIC_PATH = path.join(process.cwd(), ".master");

function main(): void {
  if (fs.existsSync(MASTER_MNEMONIC_PATH)) {
    console.error(
      "Error: .master already exists. Delete it first to generate a new mnemonic.",
    );
    console.error(
      "WARNING: deleting it makes all previously derived wallets inaccessible!",
    );
    process.exit(1);
  }

  const wallet = ethers.Wallet.createRandom();
  const mnemonic = wallet.mnemonic?.phrase;
  if (!mnemonic) {
    console.error("Error: failed to generate mnemonic");
    process.exit(1);
  }

  fs.writeFileSync(MASTER_MNEMONIC_PATH, mnemonic, {
    encoding: "utf8",
    mode: 0o600,
  });

  console.log("✅ Master mnemonic generated and saved to .master");
  console.log("⚠️  Keep this file secure and never commit it.");
  console.log(`🔑 First derived address (index 0): ${wallet.address}`);
}

main();
