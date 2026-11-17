import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../src/config.js";
import { openDb, tx } from "../src/db.js";

const countsSql = {
  users: "SELECT COUNT(*) AS n FROM users WHERE is_demo = 1",
  patients: "SELECT COUNT(*) AS n FROM patients WHERE is_demo = 1",
  appointments: `SELECT COUNT(*) AS n FROM appointments
    WHERE patient_id IN (SELECT id FROM patients WHERE is_demo = 1)
       OR created_by IN (SELECT id FROM users WHERE is_demo = 1)`,
};

function getCounts(db) {
  return Object.fromEntries(Object.entries(countsSql).map(([name, sql]) => [name, Number(db.prepare(sql).get().n)]));
}

function printCounts(counts) {
  console.log(`Demo users: ${counts.users}`);
  console.log(`Demo patients: ${counts.patients}`);
  console.log(`Demo appointments: ${counts.appointments}`);
}

export function purgeDemo(db) {
  return tx(db, () => {
    const demoAppointments = `(
      SELECT id FROM appointments
      WHERE patient_id IN (SELECT id FROM patients WHERE is_demo = 1)
         OR created_by IN (SELECT id FROM users WHERE is_demo = 1)
    )`;
    const demoPatients = "(SELECT id FROM patients WHERE is_demo = 1)";
    const demoUsers = "(SELECT id FROM users WHERE is_demo = 1)";
    const demoDentists = "(SELECT id FROM dentists WHERE user_id IN " + demoUsers + ")";

    for (const table of ["message_images", "messages"]) {
      const where = table === "message_images"
        ? `message_id IN (SELECT id FROM messages WHERE sender_user_id IN ${demoUsers}
             OR conversation_id IN (SELECT id FROM conversations WHERE patient_id IN ${demoPatients} OR dentist_id IN ${demoDentists}))`
        : `sender_user_id IN ${demoUsers}
             OR conversation_id IN (SELECT id FROM conversations WHERE patient_id IN ${demoPatients} OR dentist_id IN ${demoDentists})`;
      db.prepare(`DELETE FROM ${table} WHERE ${where}`).run();
    }
    db.prepare(`DELETE FROM conversations WHERE patient_id IN ${demoPatients} OR dentist_id IN ${demoDentists}`).run();
    for (const table of ["appointment_payments", "payment_transactions", "appointment_refunds", "appointment_counter_payments"]) {
      db.prepare(`DELETE FROM ${table} WHERE appointment_id IN ${demoAppointments}`).run();
    }
    db.prepare(`DELETE FROM dentist_reviews WHERE patient_id IN ${demoPatients} OR dentist_id IN ${demoDentists}`).run();
    db.prepare(`DELETE FROM dentist_patient_notes WHERE patient_id IN ${demoPatients} OR created_by IN ${demoUsers}`).run();
    db.prepare(`DELETE FROM slot_holds WHERE user_id IN ${demoUsers}`).run();
    db.prepare(`DELETE FROM appointments WHERE id IN ${demoAppointments}`).run();
    db.prepare(`DELETE FROM patients WHERE id IN ${demoPatients}`).run();
    db.prepare(`UPDATE patients SET created_by = NULL WHERE created_by IN ${demoUsers}`).run();
    db.prepare(`DELETE FROM dentist_time_off WHERE dentist_id IN ${demoDentists}`).run();
    db.prepare(`DELETE FROM dentist_schedules WHERE dentist_id IN ${demoDentists}`).run();
    db.prepare(`DELETE FROM dentists WHERE id IN ${demoDentists}`).run();
    db.prepare(`DELETE FROM appointment_counter_payments WHERE received_by IN ${demoUsers}`).run();
    db.prepare("DELETE FROM users WHERE is_demo = 1").run();
    return true;
  });
}

const isMain = process.argv[1] && process.argv[1].endsWith("purge-demo.js");
if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig();
  const db = openDb(config.dbPath, config.supabaseDbUrl);
  try {
    const counts = getCounts(db);
    printCounts(counts);
    if (dryRun) {
      console.log("Dry run: no data was deleted.");
    } else {
      const rl = readline.createInterface({ input, output });
      const answer = await rl.question("Type PURGE to delete all demo data: ");
      rl.close();
      if (answer !== "PURGE") {
        console.log("Purge cancelled.");
      } else {
        purgeDemo(db);
        console.log("Demo data purged.");
      }
    }
  } finally {
    db.close();
  }
}
