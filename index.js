const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
require("dotenv").config();

const verifyToken = require("./middlewares/verifyToken");

const app = express();

// ===============================
// Middleware
// ===============================
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://bookorbit-388cb.web.app",
      "https://bookorbit-388cb.firebaseapp.com",
    ],
    credentials: true,
  })
);

app.use(express.json());

// ===============================
// Root
// ===============================
app.get("/", (req, res) => {
  res.send("BookOrbit server is running");
});

// ===============================
// MongoDB Setup
// ===============================
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

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

async function run() {
  try {
    await client.connect();
    console.log("MongoDB Connected!");

    const db = client.db("bookorbitDB");

    const usersCollection = db.collection("users");
    const booksCollection = db.collection("books");
    const ordersCollection = db.collection("orders");
    const paymentsCollection = db.collection("payments");
    const wishlistCollection = db.collection("wishlist");
    const reviewsCollection = db.collection("reviews");

    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB Ping OK");

    // Unique email index
    try {
      await usersCollection.createIndex(
        { email: 1 },
        { unique: true, collation: { locale: "en", strength: 2 } }
      );
    } catch (e) {
      console.log("users email index exists");
    }

    // Reviews indexes
    try {
      await reviewsCollection.createIndex({ bookId: 1, createdAt: -1 });
      await reviewsCollection.createIndex({ userEmail: 1, createdAt: -1 });

      await reviewsCollection.createIndex(
        { bookId: 1, userEmail: 1 },
        { unique: true }
      );
    } catch (e) {
      console.log("reviews index exists");
    }

    // ===============================
    // BOOK RATING CALCULATION
    // ===============================
    const recalcBookRating = async (bookId) => {
      const stats = await reviewsCollection
        .aggregate([
          { $match: { bookId: new ObjectId(bookId) } },
          {
            $group: {
              _id: "$bookId",
              avgRating: { $avg: "$rating" },
              reviewCount: { $sum: 1 },
            },
          },
        ])
        .toArray();

      const avgRating = stats?.[0]?.avgRating
        ? Number(stats[0].avgRating.toFixed(2))
        : 0;

      const reviewCount = stats?.[0]?.reviewCount || 0;

      await booksCollection.updateOne(
        { _id: new ObjectId(bookId) },
        { $set: { avgRating, reviewCount } }
      );

      return { avgRating, reviewCount };
    };

    // =====================================================
    // USERS
    // =====================================================

    app.put("/users", async (req, res) => {
      const user = req.body;

      if (!user?.email)
        return res.status(400).send({ message: "Email required" });

      const email = normalizeEmail(user.email);

      const result = await usersCollection.updateOne(
        { email },
        {
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
        },
        { upsert: true }
      );

      res.send(result);
    });

    app.get("/users/role", verifyToken, async (req, res) => {
      const email = normalizeEmail(req.user.email);
      const user = await usersCollection.findOne({ email });

      res.send({ role: user?.role || "user" });
    });

    // =====================================================
    // BOOKS
    // =====================================================

    app.get("/books", async (req, res) => {
      const { status } = req.query;

      const query = {};
      if (status === "published") query.status = "published";

      const result = await booksCollection.find(query).toArray();

      res.send(result);
    });

    app.get("/books/:id", async (req, res) => {
      const { id } = req.params;

      if (!ObjectId.isValid(id))
        return res.status(400).send({ message: "Invalid id" });

      const book = await booksCollection.findOne({ _id: new ObjectId(id) });

      res.send(book);
    });

    app.post(
      "/books",
      verifyToken,
      requireRole(usersCollection, ["librarian", "admin"]),
      async (req, res) => {
        const data = req.body;

        const book = {
          ...data,
          price: Number(data.price),
          librarianEmail: normalizeEmail(req.user.email),
          createdAt: new Date(),
          avgRating: 0,
          reviewCount: 0,
        };

        const result = await booksCollection.insertOne(book);

        res.send(result);
      }
    );

    // =====================================================
    // REVIEWS
    // =====================================================

    app.get("/reviews", async (req, res) => {
      const { bookId } = req.query;

      if (!ObjectId.isValid(bookId))
        return res.status(400).send({ message: "Invalid id" });

      const reviews = await reviewsCollection
        .find({ bookId: new ObjectId(bookId) })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(reviews);
    });

    app.post("/reviews", verifyToken, async (req, res) => {
      const { bookId, rating, comment } = req.body;

      const email = normalizeEmail(req.user.email);

      const review = {
        bookId: new ObjectId(bookId),
        userEmail: email,
        rating: Number(rating),
        comment,
        createdAt: new Date(),
      };

      const result = await reviewsCollection.insertOne(review);

      const stats = await recalcBookRating(bookId);

      res.send({ insertedId: result.insertedId, ...stats });
    });

    // =====================================================
    // ORDERS
    // =====================================================

    app.post("/orders", verifyToken, async (req, res) => {
      const order = req.body;

      const newOrder = {
        ...order,
        bookId: new ObjectId(order.bookId),
        userEmail: normalizeEmail(req.user.email),
        status: "pending",
        paymentStatus: "unpaid",
        orderDate: new Date(),
      };

      const result = await ordersCollection.insertOne(newOrder);

      res.send(result);
    });

    app.get("/orders/my", verifyToken, async (req, res) => {
      const email = normalizeEmail(req.user.email);

      const orders = await ordersCollection
        .find({ userEmail: email })
        .sort({ orderDate: -1 })
        .toArray();

      res.send(orders);
    });

    // =====================================================
    // PAYMENTS
    // =====================================================

    app.get("/payments/my", verifyToken, async (req, res) => {
      const result = await paymentsCollection
        .find({ userEmail: normalizeEmail(req.user.email) })
        .sort({ date: -1 })
        .toArray();

      res.send(result);
    });

    // =====================================================
    // WISHLIST
    // =====================================================

    app.post("/wishlist", verifyToken, async (req, res) => {
      const data = req.body;

      const doc = {
        ...data,
        bookId: new ObjectId(data.bookId),
        userEmail: normalizeEmail(req.user.email),
        createdAt: new Date(),
      };

      const result = await wishlistCollection.insertOne(doc);

      res.send(result);
    });

    app.get("/wishlist/my", verifyToken, async (req, res) => {
      const email = normalizeEmail(req.user.email);

      const result = await wishlistCollection
        .find({ userEmail: email })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    console.log("Routes loaded");
  } catch (error) {
    console.error("run error:", error);
  }
}

run().catch(console.dir);

// ===============================
// LOCAL SERVER START
// ===============================
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 5000;

  app.listen(port, () => {
    console.log(`BookOrbit server running on port ${port}`);
  });
}

// ===============================
// EXPORT FOR VERCEL
// ===============================
module.exports = app;