import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { openDb, tx } from "../src/db.js";
import { hashPassword } from "../src/lib/security.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAdminInput({ email, password, adminCount, force = false }) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalizedEmail)) throw new Error("A valid admin email is required");
  if (String(password ?? "").length < 12) throw new Error("Admin password must be at least 12 characters");
  if (adminCount > 0 && !force) throw new Error("An admin already exists; use --force to create another");
  return { email: normalizedEmail, password: String(password) };
}

export function createAdmin(db, { email, password, force = false, fullName = "Clinic Administrator" }) {
  const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  const input = validateAdminInput({ email, password, adminCount, force });
  return tx(db, () => {
    db.prepare("INSERT INTO users (role, email, password_hash, full_name, is_demo) VALUES ('admin', ?, ?, ?, 0)")
      .run(input.email, hashPassword(input.password), fullName);
    return input.email;
  });
}

function prompt(question, { hidden = false } = {}) {
  if (!hidden) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    }));
  }

  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      reject(new Error("A TTY is required to enter a password securely"));
      return;
    }
    process.stdout.write(question);
    let answer = "";
    const onData = (chunk) => {
      const char = chunk.toString();
      if (char === "\u0003") {
        cleanup();
        reject(new Error("Input cancelled"));
      } else if (char === "\r" || char === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(answer);
      } else if (char === "\u007f") {
        answer = answer.slice(0, -1);
      } else {
        answer += char;
      }
    };
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const force = process.argv.includes("--force");
  const config = loadConfig();
  const db = openDb(config.dbPath, config.supabaseDbUrl);
  try {
    const email = await prompt("Admin email: ");
    const password = await prompt("Admin password (hidden): ", { hidden: true });
    const createdEmail = createAdmin(db, { email, password, force });
    console.log(`Admin created for ${createdEmail}.`);
  } finally {
    db.close();
  }
}
