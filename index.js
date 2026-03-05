// index.js
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
    const paymentsCollection = db.collection("payments"); // (not used yet, but keep)

    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB Ping OK");

    // =====================================================
    // USERS
    // =====================================================

    // Upsert user (sync on login/register)
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

    // ✅ Dynamic role fetching
    app.get("/users/role", verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const user = await usersCollection.findOne({ email });

        if (!user) return res.send({ role: "user" });

        res.send({ role: user.role || "user" });
      } catch (error) {
        console.error("GET /users/role error:", error);
        res.status(500).send({ message: "Failed to fetch role" });
      }
    });

    // ✅ Protected test route
    app.get("/protected", verifyToken, (req, res) => {
      res.send({
        message: "Protected route accessed!",
        user: req.user,
      });
    });

    // =====================================================
    // BOOKS
    // =====================================================

    // Add Book (Librarian/Admin) - role check optional here (frontend already protects)
    app.post("/books", verifyToken, async (req, res) => {
      try {
        const bookData = req.body;

        const newBook = {
          name: bookData.name,
          author: bookData.author,
          image: bookData.image, // you can store imgbb URL or later file upload url
          price: Number(bookData.price),
          status: bookData.status || "unpublished", // published/unpublished
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

    // ✅ Public books (published only) - supports query: /books?status=published
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
        console.error("GET /books error:", error);
        res.status(500).send({ message: "Failed to fetch books" });
      }
    });

    // ✅ Get my books (Librarian/Admin)  --- keep this BEFORE /books/:id
    app.get("/books/mine", verifyToken, async (req, res) => {
      try {
        const email = req.user.email;

        const result = await booksCollection
          .find({ librarianEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        console.error("GET /books/mine error:", error);
        res.status(500).send({ message: "Failed to fetch books" });
      }
    });

    // ✅ Get single book by id
    app.get("/books/:id", async (req, res) => {
      try {
        const { id } = req.params;

        const book = await booksCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!book) return res.status(404).send({ message: "Book not found" });

        res.send(book);
      } catch (error) {
        console.error("GET /books/:id error:", error);
        res.status(500).send({ message: "Failed to fetch book" });
      }
    });

    // Update Book (Admin OR Owner Librarian)
    app.patch("/books/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const updatedData = req.body;

        const book = await booksCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!book) return res.status(404).send({ message: "Book not found" });

        const user = await usersCollection.findOne({
          email: req.user.email,
        });

        if (!user) return res.status(403).send({ message: "Unauthorized" });

        if (user.role !== "admin" && book.librarianEmail !== req.user.email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        // ✅ ensure these are correct types if they exist
        if (updatedData.price) updatedData.price = Number(updatedData.price);

        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedData }
        );

        res.send(result);
      } catch (error) {
        console.error("PATCH /books/:id error:", error);
        res.status(500).send({ message: "Failed to update book" });
      }
    });

    // Delete Book (Admin OR Owner Librarian)
    app.delete("/books/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;

        const book = await booksCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!book) return res.status(404).send({ message: "Book not found" });

        const user = await usersCollection.findOne({
          email: req.user.email,
        });

        if (!user) return res.status(403).send({ message: "Unauthorized" });

        if (user.role !== "admin" && book.librarianEmail !== req.user.email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        await booksCollection.deleteOne({
          _id: new ObjectId(id),
        });

        // requirement says: deleting book will delete all orders of that book
        await ordersCollection.deleteMany({ bookId: new ObjectId(id) });

        res.send({ message: "Book deleted successfully" });
      } catch (error) {
        console.error("DELETE /books/:id error:", error);
        res.status(500).send({ message: "Delete failed" });
      }
    });

    // =====================================================
    // ORDERS (User)
    // =====================================================

    // Create order (User)
    // IMPORTANT: orderData.bookId should be a string id from frontend, we convert to ObjectId
    app.post("/orders", verifyToken, async (req, res) => {
      try {
        const orderData = req.body;

        if (!orderData?.bookId) {
          return res.status(400).send({ message: "bookId required" });
        }

        const newOrder = {
          ...orderData,
          bookId: new ObjectId(orderData.bookId), // ✅ convert here
          userEmail: req.user.email,
          status: "pending", // pending/shipped/delivered/cancelled
          paymentStatus: "unpaid", // unpaid/paid
          orderDate: new Date(),
        };

        const result = await ordersCollection.insertOne(newOrder);
        res.send(result);
      } catch (error) {
        console.error("POST /orders error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Get my orders (User)
    app.get("/orders/my", verifyToken, async (req, res) => {
      try {
        const email = req.user.email;

        const result = await ordersCollection
          .find({ userEmail: email })
          .sort({ orderDate: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        console.error("GET /orders/my error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Cancel order (User) - only if pending
    app.patch("/orders/:id/cancel", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const email = req.user.email;

        const order = await ordersCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!order) return res.status(404).send({ message: "Order not found" });

        if (order.userEmail !== email)
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
      } catch (error) {
        console.error("PATCH /orders/:id/cancel error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // =====================================================
    // ORDERS (Librarian/Admin)
    // Librarian can see ALL orders for books they added,
    // including published + unpublished books
    // =====================================================

    app.get("/librarian/orders", verifyToken, async (req, res) => {
      try {
        const librarianEmail = req.user.email;

        const result = await ordersCollection
          .aggregate([
            {
              $lookup: {
                from: "books",
                localField: "bookId", // must be ObjectId
                foreignField: "_id",
                as: "bookData",
              },
            },
            { $unwind: "$bookData" },
            {
              $match: {
                "bookData.librarianEmail": librarianEmail,
              },
            },
            { $sort: { orderDate: -1 } },
            {
              $project: {
                _id: 1,
                userEmail: 1,
                status: 1,
                paymentStatus: 1,
                orderDate: 1,

                bookId: 1,
                bookName: "$bookData.name",
                bookImage: "$bookData.image",
                bookPrice: "$bookData.price",
                bookStatus: "$bookData.status", // published/unpublished
                librarianEmail: "$bookData.librarianEmail",
              },
            },
          ])
          .toArray();

        res.send(result);
      } catch (error) {
        console.error("GET /librarian/orders error:", error);
        res.status(500).send({ message: "Failed to fetch librarian orders" });
      }
    });

    // =====================================================
    // (Optional) ADMIN - later: all users, make admin/librarian
    // I'll build next when you say "OK"
    // =====================================================
  } catch (error) {
    console.error("❌ run() error:", error);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});