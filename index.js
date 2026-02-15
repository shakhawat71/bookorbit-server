const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

// ✅ Middleware
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());

// ✅ Firebase verifyToken
const verifyToken = require("./middlewares/verifyToken");

// ✅ Root route
app.get("/", (req, res) => {
  res.send("BookOrbit server is running ✅");
});

// ✅ Mongo URI
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
    // ✅ MUST connect
    await client.connect();
    console.log("✅ MongoDB Connected!");

    const db = client.db("bookorbitDB");

    const usersCollection = db.collection("users");
    const booksCollection = db.collection("books");
    const ordersCollection = db.collection("orders");
    const paymentsCollection = db.collection("payments");

    // ✅ Ping test
    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB Ping OK");

    // ===============================
    // USERS (Upsert on login/register)
    // ===============================
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

    // ===============================
    // PROTECTED TEST ROUTE
    // ===============================
    app.get("/protected", verifyToken, (req, res) => {
      res.send({
        message: "Protected route accessed!",
        user: req.user,
      });
    });

   
    // BOOK ROUTES


    // Add Book
    app.post("/books", verifyToken, async (req, res) => {
    try {
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


    // Get All Books (Admin / Testing)
    app.get("/books", async (req, res) => {
    const result = await booksCollection.find().toArray();
    res.send(result);
    });


    // Get My Books (Librarian)
    app.get("/books/mine", verifyToken, async (req, res) => {
    try {
        const email = req.user.email;

        const result = await booksCollection
        .find({ librarianEmail: email })
        .toArray();

        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Failed to fetch books" });
    }
    });


    //  Update Book (Admin or Owner Librarian)
    app.patch("/books/:id", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const updatedData = req.body;

        const book = await booksCollection.findOne({
        _id: new ObjectId(id),
        });

        if (!book)
        return res.status(404).send({ message: "Book not found" });

        const user = await usersCollection.findOne({
        email: req.user.email,
        });

        if (!user)
        return res.status(403).send({ message: "Unauthorized" });

        if (
        user.role !== "admin" &&
        book.librarianEmail !== req.user.email
        ) {
        return res.status(403).send({ message: "Forbidden" });
        }

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


    //  Delete Book (Admin Only)
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

    if (!user)
      return res.status(403).send({ message: "Unauthorized" });

    // ✅ Admin OR librarian who created it
    if (
      user.role !== "admin" &&
      book.librarianEmail !== req.user.email
    ) {
      return res.status(403).send({ message: "Forbidden" });
    }

    await booksCollection.deleteOne({ _id: new ObjectId(id) });

    res.send({ message: "Book deleted successfully" });
  } catch (error) {
    res.status(500).send({ message: "Delete failed" });
  }
});




    // ORDERS


    // Create order
    app.post("/orders", verifyToken, async (req, res) => {
      try {
        const orderData = req.body;

        const newOrder = {
          ...orderData,
          userEmail: req.user.email,
          status: "pending",
          paymentStatus: "unpaid",
          orderDate: new Date(),
        };

        const result = await ordersCollection.insertOne(newOrder);
        res.send(result);
      } catch (error) {
        console.error("POST /orders error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Get my orders
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

    //  Cancel order
    app.patch("/orders/:id/cancel", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const email = req.user.email;

        const order = await ordersCollection.findOne({ _id: new ObjectId(id) });

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
  } catch (error) {
    console.error(" run() error:", error);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(` Server running on port ${port}`);
});
