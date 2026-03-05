// ✅ server/index.js (FULL - with Users, Books, Orders, Payments, Wishlist, Admin + Librarian features)
const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
require("dotenv").config();

const verifyToken = require("./middlewares/verifyToken");

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
// Root
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
    console.log("✅ MongoDB Connected!");

    const db = client.db("bookorbitDB");

    const usersCollection = db.collection("users");
    const booksCollection = db.collection("books");
    const ordersCollection = db.collection("orders");
    const paymentsCollection = db.collection("payments");
    const wishlistCollection = db.collection("wishlist");

    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB Ping OK");

    // ✅ Unique email index (case-insensitive)
    // If you had duplicates earlier, you already fixed them, so this should work now.
    try {
      await usersCollection.createIndex(
        { email: 1 },
        { unique: true, collation: { locale: "en", strength: 2 } }
      );
    } catch (e) {
      console.log("⚠️ users email unique index not created:", e?.message);
    }

    // =====================================================
    // USERS
    // =====================================================

    // Upsert user (sync on login/register)
    app.put("/users", async (req, res) => {
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

    // Role fetch (for client AuthContext)
    app.get("/users/role", verifyToken, async (req, res) => {
      try {
        const email = normalizeEmail(req.user.email);
        const user = await usersCollection.findOne({ email });
        res.send({ role: user?.role || "user" });
      } catch (e) {
        res.status(500).send({ message: "Failed to fetch role" });
      }
    });

    // Admin: get all users
    app.get(
      "/users",
      verifyToken,
      requireRole(usersCollection, ["admin"]),
      async (req, res) => {
        try {
          const users = await usersCollection
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
          res.send(users);
        } catch (e) {
          res.status(500).send({ message: "Failed to fetch users" });
        }
      }
    );

    // Admin: update user role
    app.patch(
      "/users/role/:email",
      verifyToken,
      requireRole(usersCollection, ["admin"]),
      async (req, res) => {
        try {
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
      }
    );

    // =====================================================
    // BOOKS
    // =====================================================

    // Add book (librarian/admin)
    app.post(
      "/books",
      verifyToken,
      requireRole(usersCollection, ["librarian", "admin"]),
      async (req, res) => {
        try {
          const bookData = req.body;

          const newBook = {
            name: bookData.name,
            author: bookData.author,
            image: bookData.image,
            price: Number(bookData.price),
            status: bookData.status || "unpublished",
            description: bookData.description || "",
            librarianEmail: normalizeEmail(req.user.email),
            createdAt: new Date(),
          };

          const result = await booksCollection.insertOne(newBook);
          res.send(result);
        } catch (e) {
          res.status(500).send({ message: "Failed to add book" });
        }
      }
    );

    // My books (librarian/admin) - must be BEFORE /books/:id
    app.get(
      "/books/mine",
      verifyToken,
      requireRole(usersCollection, ["librarian", "admin"]),
      async (req, res) => {
        try {
          const email = normalizeEmail(req.user.email);
          const result = await booksCollection
            .find({ librarianEmail: email })
            .sort({ createdAt: -1 })
            .toArray();
          res.send(result);
        } catch (e) {
          res.status(500).send({ message: "Failed to fetch books" });
        }
      }
    );

    // Admin: all books
    app.get(
      "/admin/books",
      verifyToken,
      requireRole(usersCollection, ["admin"]),
      async (req, res) => {
        try {
          const books = await booksCollection
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
          res.send(books);
        } catch (e) {
          res.status(500).send({ message: "Failed to fetch books" });
        }
      }
    );

    // Admin: publish/unpublish
    app.patch(
      "/admin/books/:id/status",
      verifyToken,
      requireRole(usersCollection, ["admin"]),
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid book id" });
          }
          if (!["published", "unpublished"].includes(status)) {
            return res.status(400).send({ message: "Invalid status" });
          }

          const result = await booksCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );
          res.send(result);
        } catch (e) {
          res.status(500).send({ message: "Failed to update status" });
        }
      }
    );

    // Public books (supports ?status=published)
    app.get("/books", async (req, res) => {
      try {
        const { status } = req.query;
        const query = {};
        if (status === "published") query.status = "published";

        const result = await booksCollection.find(query).toArray();
        res.send(result);
      } catch (e) {
        res.status(500).send({ message: "Failed to fetch books" });
      }
    });

    // Single book
    app.get("/books/:id", async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid book id" });
        }

        const book = await booksCollection.findOne({ _id: new ObjectId(id) });
        if (!book) return res.status(404).send({ message: "Book not found" });

        res.send(book);
      } catch (e) {
        res.status(500).send({ message: "Failed to fetch book" });
      }
    });

    // Update book (admin OR owner librarian)
    app.patch("/books/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const updatedData = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid book id" });
        }

        const book = await booksCollection.findOne({ _id: new ObjectId(id) });
        if (!book) return res.status(404).send({ message: "Book not found" });

        const role = await getUserRole(usersCollection, req.user.email);

        if (role !== "admin" && book.librarianEmail !== normalizeEmail(req.user.email)) {
          return res.status(403).send({ message: "Forbidden" });
        }

        if (updatedData.price) updatedData.price = Number(updatedData.price);

        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedData }
        );

        res.send(result);
      } catch (e) {
        res.status(500).send({ message: "Failed to update book" });
      }
    });

    // Delete book (admin OR owner librarian) + delete all orders of that book
    app.delete("/books/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid book id" });
        }

        const book = await booksCollection.findOne({ _id: new ObjectId(id) });
        if (!book) return res.status(404).send({ message: "Book not found" });

        const role = await getUserRole(usersCollection, req.user.email);

        if (role !== "admin" && book.librarianEmail !== normalizeEmail(req.user.email)) {
          return res.status(403).send({ message: "Forbidden" });
        }

        await booksCollection.deleteOne({ _id: new ObjectId(id) });
        await ordersCollection.deleteMany({ bookId: new ObjectId(id) });

        res.send({ message: "Book deleted successfully" });
      } catch (e) {
        res.status(500).send({ message: "Delete failed" });
      }
    });

    // =====================================================
    // ORDERS
    // =====================================================

    // Create order
    app.post("/orders", verifyToken, async (req, res) => {
      try {
        const orderData = req.body;

        if (!orderData?.bookId) {
          return res.status(400).send({ message: "bookId required" });
        }
        if (!ObjectId.isValid(orderData.bookId)) {
          return res.status(400).send({ message: "Invalid bookId" });
        }

        const newOrder = {
          ...orderData,
          bookId: new ObjectId(orderData.bookId),
          userEmail: normalizeEmail(req.user.email),
          status: "pending",
          paymentStatus: "unpaid",
          orderDate: new Date(),
        };

        const result = await ordersCollection.insertOne(newOrder);
        res.send(result);
      } catch (e) {
        res.status(500).send({ message: "Server error" });
      }
    });

    // My orders - must be BEFORE /orders/:id
    app.get("/orders/my", verifyToken, async (req, res) => {
      try {
        const email = normalizeEmail(req.user.email);
        const result = await ordersCollection
          .find({ userEmail: email })
          .sort({ orderDate: -1 })
          .toArray();
        res.send(result);
      } catch (e) {
        res.status(500).send({ message: "Server error" });
      }
    });

    // Single order (payment page)
    app.get("/orders/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid order id" });
        }

        const order = await ordersCollection.findOne({ _id: new ObjectId(id) });
        if (!order) return res.status(404).send({ message: "Order not found" });

        if (order.userEmail !== normalizeEmail(req.user.email)) {
          return res.status(403).send({ message: "Forbidden" });
        }

        res.send(order);
      } catch (e) {
        res.status(500).send({ message: "Server error" });
      }
    });

    // Cancel order (pending + unpaid only)
    app.patch("/orders/:id/cancel", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const email = normalizeEmail(req.user.email);

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid order id" });
        }

        const order = await ordersCollection.findOne({ _id: new ObjectId(id) });
        if (!order) return res.status(404).send({ message: "Order not found" });

        if (order.userEmail !== email) return res.status(403).send({ message: "Forbidden" });

        if (order.status !== "pending") {
          return res.status(400).send({ message: "Only pending orders can be cancelled" });
        }

        if (order.paymentStatus === "paid") {
          return res.status(400).send({ message: "Paid orders cannot be cancelled" });
        }

        const result = await ordersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "cancelled" } }
        );
        res.send(result);
      } catch (e) {
        res.status(500).send({ message: "Server error" });
      }
    });

    // Pay order (simple simulation) => creates payment record for invoices
    app.patch("/orders/:id/pay", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid order id" });
        }

        const order = await ordersCollection.findOne({ _id: new ObjectId(id) });
        if (!order) return res.status(404).send({ message: "Order not found" });

        if (order.userEmail !== normalizeEmail(req.user.email)) {
          return res.status(403).send({ message: "Forbidden" });
        }

        if (order.paymentStatus === "paid") {
          return res.status(400).send({ message: "Already paid" });
        }

        await ordersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { paymentStatus: "paid", paidAt: new Date() } }
        );

        await paymentsCollection.insertOne({
          orderId: new ObjectId(id),
          userEmail: normalizeEmail(req.user.email),
          amount: Number(order.price || 0),
          paymentId: `PAY-${Date.now()}`,
          date: new Date(),
        });

        res.send({ message: "Payment successful" });
      } catch (e) {
        res.status(500).send({ message: "Server error" });
      }
    });

    // =====================================================
    // LIBRARIAN / ADMIN - ORDERS FOR THEIR BOOKS
    // =====================================================

    // Librarian/Admin view orders (admin sees all, librarian sees own)
    app.get(
      "/librarian/orders",
      verifyToken,
      requireRole(usersCollection, ["librarian", "admin"]),
      async (req, res) => {
        try {
          const librarianEmail = normalizeEmail(req.user.email);
          const role = await getUserRole(usersCollection, librarianEmail);

          const matchStage =
            role === "admin" ? {} : { "bookData.librarianEmail": librarianEmail };

          const result = await ordersCollection
            .aggregate([
              {
                $lookup: {
                  from: "books",
                  localField: "bookId",
                  foreignField: "_id",
                  as: "bookData",
                },
              },
              { $unwind: "$bookData" },
              { $match: matchStage },
              { $sort: { orderDate: -1 } },
              {
                $project: {
                  _id: 1,
                  userEmail: 1,
                  status: 1,
                  paymentStatus: 1,
                  orderDate: 1,
                  customerName: 1,
                  phone: 1,
                  address: 1,
                  bookId: 1,
                  bookName: "$bookData.name",
                  bookImage: "$bookData.image",
                  bookPrice: "$bookData.price",
                  bookStatus: "$bookData.status",
                  librarianEmail: "$bookData.librarianEmail",
                },
              },
            ])
            .toArray();

          res.send(result);
        } catch (e) {
          res.status(500).send({ message: "Failed to fetch orders" });
        }
      }
    );

    // Librarian/Admin update order status
    app.patch(
      "/librarian/orders/:id/status",
      verifyToken,
      requireRole(usersCollection, ["librarian", "admin"]),
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid order id" });
          }

          if (!["pending", "shipped", "delivered", "cancelled"].includes(status)) {
            return res.status(400).send({ message: "Invalid status" });
          }

          const order = await ordersCollection.findOne({ _id: new ObjectId(id) });
          if (!order) return res.status(404).send({ message: "Order not found" });

          const role = await getUserRole(usersCollection, req.user.email);

          if (role !== "admin") {
            const book = await booksCollection.findOne({ _id: order.bookId });
            if (!book) return res.status(404).send({ message: "Book not found" });

            if (book.librarianEmail !== normalizeEmail(req.user.email)) {
              return res.status(403).send({ message: "Forbidden" });
            }
          }

          const result = await ordersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );

          res.send(result);
        } catch (e) {
          res.status(500).send({ message: "Failed to update order status" });
        }
      }
    );

    // =====================================================
    // PAYMENTS (Invoices)
    // =====================================================
    app.get("/payments/my", verifyToken, async (req, res) => {
      try {
        const result = await paymentsCollection
          .find({ userEmail: normalizeEmail(req.user.email) })
          .sort({ date: -1 })
          .toArray();
        res.send(result);
      } catch (e) {
        res.status(500).send({ message: "Failed to fetch payments" });
      }
    });

    // =====================================================
    // WISHLIST
    // =====================================================

    // Add to wishlist
    app.post("/wishlist", verifyToken, async (req, res) => {
      try {
        const data = req.body;

        if (!data?.bookId) return res.status(400).send({ message: "bookId required" });
        if (!ObjectId.isValid(data.bookId)) {
          return res.status(400).send({ message: "Invalid bookId" });
        }

        const userEmail = normalizeEmail(req.user.email);

        const exists = await wishlistCollection.findOne({
          userEmail,
          bookId: new ObjectId(data.bookId),
        });

        if (exists) return res.send({ message: "Already in wishlist" });

        const doc = {
          userEmail,
          bookId: new ObjectId(data.bookId),
          bookName: data.bookName || "",
          bookAuthor: data.bookAuthor || "",
          bookImage: data.bookImage || "",
          price: Number(data.price || 0),
          createdAt: new Date(),
        };

        const result = await wishlistCollection.insertOne(doc);
        res.send(result);
      } catch (e) {
        res.status(500).send({ message: "Failed to add wishlist" });
      }
    });

    // My wishlist
    app.get("/wishlist/my", verifyToken, async (req, res) => {
      try {
        const userEmail = normalizeEmail(req.user.email);
        const result = await wishlistCollection
          .find({ userEmail })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (e) {
        res.status(500).send({ message: "Failed to fetch wishlist" });
      }
    });

    // Remove wishlist item
    app.delete("/wishlist/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid wishlist id" });
        }

        const userEmail = normalizeEmail(req.user.email);

        const item = await wishlistCollection.findOne({ _id: new ObjectId(id) });
        if (!item) return res.status(404).send({ message: "Not found" });

        if (item.userEmail !== userEmail) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const result = await wishlistCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch (e) {
        res.status(500).send({ message: "Failed to remove" });
      }
    });

    console.log("✅ Routes loaded");
  } catch (error) {
    console.error("❌ run() error:", error);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});