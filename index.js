const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

// ===============================
// Middleware
// ===============================
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());

// ===============================
// Firebase verifyToken middleware
// ===============================
const verifyToken = require("./middlewares/verifyToken");

// ===============================
// Root Route
// ===============================
app.get("/", (req, res) => {
  res.send("BookOrbit server is running ✅");
});

// ===============================
// MongoDB Setup
// ===============================
const uri = process.env.MONGODB_URI;
if (!uri) console.log("❌ MONGODB_URI missing in .env");

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    console.log("✅ MongoDB Connected!");

    const db = client.db("bookorbitDB");

    const usersCollection = db.collection("users");
    const booksCollection = db.collection("books");
    const ordersCollection = db.collection("orders");
    const paymentsCollection = db.collection("payments");

    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB Ping OK");

    // =====================================================
    // USERS
    // =====================================================

    // Upsert user (Login/Register sync)
    app.put("/users", async (req, res) => {
      const user = req.body;

      if (!user?.email) {
        return res.status(400).send({ message: "Email required" });
      }

      const filter = { email: user.email };

      const updateDoc = {
        $set: {
          name: user.name || "",
          email: user.email,
          photoURL: user.photoURL || "",
        },
        $setOnInsert: {
          role: "user",
          createdAt: new Date(),
        },
      };

      const result = await usersCollection.updateOne(filter, updateDoc, {
        upsert: true,
      });

      res.send(result);
    });

    // Get current user role
    app.get("/users/role", verifyToken, async (req, res) => {
      try {
        const user = await usersCollection.findOne({
          email: req.user.email,
        });

        res.send({ role: user?.role || "user" });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch role" });
      }
    });

    // =====================================================
    // BOOK ROUTES
    // =====================================================

    // Add Book (Only Librarian or Admin)
    app.post("/books", verifyToken, async (req, res) => {
      try {
        const user = await usersCollection.findOne({
          email: req.user.email,
        });

        if (!user || (user.role !== "librarian" && user.role !== "admin")) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const bookData = req.body;

        const newBook = {
          name: bookData.name,
          author: bookData.author,
          image: bookData.image,
          price: Number(bookData.price),
          status: bookData.status || "unpublished",
          description: bookData.description || "",
          librarianEmail: req.user.email,
          createdAt: new Date(),
        };

        const result = await booksCollection.insertOne(newBook);
        res.send(result);
      } catch (error) {
        console.error("POST /books error:", error);
        res.status(500).send({ message: "Failed to add book" });
      }
    });

    // ✅ Public books (published only support via query)
    app.get("/books", async (req, res) => {
      try {
        const { status } = req.query;

        let query = {};

        if (status === "published") {
          query.status = "published";
        }

        const result = await booksCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch books" });
      }
    });

    // Get my books (Librarian)
    app.get("/books/mine", verifyToken, async (req, res) => {
      try {
        const result = await booksCollection
          .find({ librarianEmail: req.user.email })
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch books" });
      }
    });

    // Update Book
    app.patch("/books/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;

        const book = await booksCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!book)
          return res.status(404).send({ message: "Book not found" });

        const user = await usersCollection.findOne({
          email: req.user.email,
        });

        if (
          user.role !== "admin" &&
          book.librarianEmail !== req.user.email
        ) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: req.body }
        );

        res.send(result);
      } catch (error) {
        console.error("PATCH /books/:id error:", error);
        res.status(500).send({ message: "Update failed" });
      }
    });

    // Delete Book
    app.delete("/books/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;

        const book = await booksCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!book)
          return res.status(404).send({ message: "Book not found" });

        const user = await usersCollection.findOne({
          email: req.user.email,
        });

        if (
          user.role !== "admin" &&
          book.librarianEmail !== req.user.email
        ) {
          return res.status(403).send({ message: "Forbidden" });
        }

        await booksCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send({ message: "Book deleted successfully" });
      } catch (error) {
        console.error("DELETE /books/:id error:", error);
        res.status(500).send({ message: "Delete failed" });
      }
    });

    // Get single book by id
      app.get("/books/:id", async (req, res) => {
        try {
          const { id } = req.params;

          const book = await booksCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!book)
            return res.status(404).send({ message: "Book not found" });

          res.send(book);
        } catch (error) {
          res.status(500).send({ message: "Failed to fetch book" });
        }
      });


    // =====================================================
    // ORDERS
    // =====================================================

    app.post("/orders", verifyToken, async (req, res) => {
      try {
        const newOrder = {
          ...req.body,
          userEmail: req.user.email,
          status: "pending",
          paymentStatus: "unpaid",
          orderDate: new Date(),
        };

        const result = await ordersCollection.insertOne(newOrder);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Server error" });
      }
    });

    app.get("/orders/my", verifyToken, async (req, res) => {
      const result = await ordersCollection
        .find({ userEmail: req.user.email })
        .sort({ orderDate: -1 })
        .toArray();

      res.send(result);
    });

    app.patch("/orders/:id/cancel", verifyToken, async (req, res) => {
      const { id } = req.params;

      const order = await ordersCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!order)
        return res.status(404).send({ message: "Order not found" });

      if (order.userEmail !== req.user.email)
        return res.status(403).send({ message: "Forbidden" });

      if (order.status !== "pending")
        return res
          .status(400)
          .send({ message: "Only pending orders can be cancelled" });

      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "cancelled" } }
      );

      res.send(result);
    });

  } catch (error) {
    console.error("❌ run() error:", error);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
