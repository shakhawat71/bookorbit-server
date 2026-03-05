require("dotenv").config();
const { MongoClient, ServerApiVersion } = require("mongodb");

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const normalizeEmail = (email) => (email ? String(email).toLowerCase() : "");

async function main() {
  await client.connect();
  const db = client.db("bookorbitDB");
  const users = db.collection("users");

  const all = await users.find({ email: { $exists: true } }).toArray();

  const map = new Map(); // key: lower email -> keep one doc
  const dupIds = [];

  for (const u of all) {
    const key = normalizeEmail(u.email);
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, u); // keep first
    } else {
      // keep the newest one if possible
      const kept = map.get(key);
      const keptTime = new Date(kept.updatedAt || kept.createdAt || 0).getTime();
      const curTime = new Date(u.updatedAt || u.createdAt || 0).getTime();

      if (curTime > keptTime) {
        dupIds.push(kept._id);
        map.set(key, u);
      } else {
        dupIds.push(u._id);
      }
    }
  }

  if (dupIds.length > 0) {
    await users.deleteMany({ _id: { $in: dupIds } });
    console.log(`✅ Deleted duplicate users: ${dupIds.length}`);
  } else {
    console.log("✅ No duplicates found");
  }

  // make sure all emails are saved lowercase
  for (const u of map.values()) {
    const lower = normalizeEmail(u.email);
    if (u.email !== lower) {
      await users.updateOne({ _id: u._id }, { $set: { email: lower } });
    }
  }

  console.log("✅ Normalized emails to lowercase");

  // now create index
  await users.createIndex(
    { email: 1 },
    { unique: true, collation: { locale: "en", strength: 2 } }
  );
  console.log("✅ Unique email index created");

  await client.close();
}

main().catch((e) => {
  console.error("❌ Fix script error:", e);
  process.exit(1);
});