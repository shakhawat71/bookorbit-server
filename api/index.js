// server/api/index.js
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();

const verifyToken = require("../middlewares/verifyToken");

const app = express();

// CORS (allow local +  deployed client domain)
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      // add your deployed client url(s) too:
      // "https://your-client.vercel.app",
    ],
    credentials: true,
  })
);

app.use(express.json());

// Root
app.get("/", (req, res) => {
  res.send("BookOrbit server is running ✅ (Vercel)");
});

// ===============================
// MongoDB (CACHED CLIENT FOR SERVERLESS)
// ===============================
const uri = process.env.MONGODB_URI;
if (!uri) console.log("❌ MONGODB_URI missing in env");

let cachedClient = null;
let cachedDb = null;

async function connectDB() {
  if (cachedDb) return cachedDb;

  const client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });

  await client.connect();

  cachedClient = client;
  cachedDb = client.db("bookorbitDB");
  return cachedDb;
}

// ===============================
// Helpers
// ===============================
const normalizeEmail = (email) => (email ? String(email).toLowerCase() : "");

const getUserRole = async (usersCollection, email) => {
  const user = await usersCollection.findOne({ email: normalizeEmail(email) });
  return user?.role || "user";
};

const requireRole =
  (usersCollection, allowed = []) =>
  async (req, res, next) => {
    try {
      const role = await getUserRole(usersCollection, req.user.email);
      if (!allowed.includes(role)) {
        return res.status(403).send({ message: "Forbidden" });
      }
      req.role = role;
      next();
    } catch (e) {
      return res.status(500).send({ message: "Role check failed" });
    }
  };

// ===============================
// Routes (wrap in a DB loader middleware)
// ===============================
app.use(async (req, res, next) => {
  try {
    req.db = await connectDB();
    req.collections = {
      users: req.db.collection("users"),
      books: req.db.collection("books"),
      orders: req.db.collection("orders"),
      payments: req.db.collection("payments"),
      wishlist: req.db.collection("wishlist"),
      reviews: req.db.collection("reviews"),
    };
    next();
  } catch (e) {
    console.log("DB connect error:", e);
    res.status(500).send({ message: "Database connection failed" });
  }
});

// =====================================================
// USERS
// =====================================================
app.put("/users", async (req, res) => {
  const usersCollection = req.collections.users;

  const user = req.body;
  if (!user?.email) return res.status(400).send({ message: "Email required" });

  const email = normalizeEmail(user.email);

  const filter = { email };
  const updateDoc = {
    $set: {
      name: user.name || "",
      email,
      photoURL: user.photoURL || "",
      updatedAt: new Date(),
    },
    $setOnInsert: {
      role: "user",
      createdAt: new Date(),
    },
  };

  const result = await usersCollection.updateOne(filter, updateDoc, {
    upsert: true,
    collation: { locale: "en", strength: 2 },
  });

  res.send(result);
});

app.get("/users/role", verifyToken, async (req, res) => {
  try {
    const usersCollection = req.collections.users;
    const email = normalizeEmail(req.user.email);
    const user = await usersCollection.findOne({ email });
    res.send({ role: user?.role || "user" });
  } catch (e) {
    res.status(500).send({ message: "Failed to fetch role" });
  }
});

app.get("/users", verifyToken, async (req, res, next) => {
  const usersCollection = req.collections.users;
  return requireRole(usersCollection, ["admin"])(req, res, next);
}, async (req, res) => {
  try {
    const usersCollection = req.collections.users;
    const users = await usersCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.send(users);
  } catch (e) {
    res.status(500).send({ message: "Failed to fetch users" });
  }
});

app.patch("/users/role/:email", verifyToken, async (req, res, next) => {
  const usersCollection = req.collections.users;
  return requireRole(usersCollection, ["admin"])(req, res, next);
}, async (req, res) => {
  try {
    const usersCollection = req.collections.users;

    const email = normalizeEmail(req.params.email);
    const { role } = req.body;

    if (!["user", "librarian", "admin"].includes(role)) {
      return res.status(400).send({ message: "Invalid role" });
    }

    const result = await usersCollection.updateOne(
      { email },
      { $set: { role } },
      { collation: { locale: "en", strength: 2 } }
    );

    res.send(result);
  } catch (e) {
    res.status(500).send({ message: "Failed to update role" });
  }
});

// =====================================================
// BOOKS (same logic as your server)
// =====================================================
app.post("/books", verifyToken, async (req, res, next) => {
  const usersCollection = req.collections.users;
  return requireRole(usersCollection, ["librarian", "admin"])(req, res, next);
}, async (req, res) => {
  try {
    const booksCollection = req.collections.books;

    const bookData = req.body;

    const newBook = {
      name: bookData.name,
      author: bookData.author,
      image: bookData.image,
      price: Number(bookData.price),
      status: bookData.status || "unpublished",
      description: bookData.description || "",
      librarianEmail: normalizeEmail(req.user.email),
      avgRating: 0,
      reviewCount: 0,
      createdAt: new Date(),
    };

    const result = await booksCollection.insertOne(newBook);
    res.send(result);
  } catch (e) {
    res.status(500).send({ message: "Failed to add book" });
  }
});

app.get("/books", async (req, res) => {
  try {
    const booksCollection = req.collections.books;
    const { status } = req.query;

    const query = {};
    if (status === "published") query.status = "published";

    const result = await booksCollection.find(query).toArray();
    res.send(result);
  } catch (e) {
    res.status(500).send({ message: "Failed to fetch books" });
  }
});

app.get("/books/:id", async (req, res) => {
  try {
    const booksCollection = req.collections.books;
    const { id } = req.params;

    if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid book id" });

    const book = await booksCollection.findOne({ _id: new ObjectId(id) });
    if (!book) return res.status(404).send({ message: "Book not found" });

    res.send(book);
  } catch (e) {
    res.status(500).send({ message: "Failed to fetch book" });
  }
});

// =====================================================
// IMPORTANT: Export app for Vercel
// =====================================================
module.exports = app;