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
if (!uri) console.log("MONGODB_URI missing in .env");

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

    // Unique email index (case-insensitive)
    try {
      await usersCollection.createIndex(
        { email: 1 },
        { unique: true, collation: { locale: "en", strength: 2 } }
      );
    } catch (e) {
      console.log("users email unique index not created:", e?.message);
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
      console.log("reviews indexes:", e?.message);
    }

    // Recalculate rating for a book
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

    // Upsert user (sync on login/register)
    app.put("/users", verifyToken, async (req, res) => {
      try {
        const user = req.body;

        if (!user?.email) {
          return res.status(400).send({ message: "Email required" });
        }

        const email = normalizeEmail(user.email);

        if (normalizeEmail(req.user.email) !== email) {
          return res.status(403).send({ message: "Forbidden" });
        }

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
      } catch (e) {
        console.log("PUT /users error:", e);
        res.status(500).send({ message: "Failed to save user" });
      }
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
            avgRating: 0,
            reviewCount: 0,
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

        if (
          role !== "admin" &&
          book.librarianEmail !== normalizeEmail(req.user.email)
        ) {
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

    // Delete book (admin OR owner librarian) + delete all orders + delete reviews
    app.delete("/books/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid book id" });
        }

        const book = await booksCollection.findOne({ _id: new ObjectId(id) });
        if (!book) return res.status(404).send({ message: "Book not found" });

        const role = await getUserRole(usersCollection, req.user.email);

        if (
          role !== "admin" &&
          book.librarianEmail !== normalizeEmail(req.user.email)
        ) {
          return res.status(403).send({ message: "Forbidden" });
        }

        await booksCollection.deleteOne({ _id: new ObjectId(id) });
        await ordersCollection.deleteMany({ bookId: new ObjectId(id) });
        await reviewsCollection.deleteMany({ bookId: new ObjectId(id) });

        res.send({ message: "Book deleted successfully" });
      } catch (e) {
        res.status(500).send({ message: "Delete failed" });
      }
    });

    // =====================================================
    // REVIEWS & RATINGS
    // =====================================================

    // Get reviews for a book: /reviews?bookId=xxxx
    app.get("/reviews", async (req, res) => {
  try {
    const { bookId } = req.query;

    if (!bookId || !ObjectId.isValid(bookId)) {
      return res.status(400).send({ message: "Valid bookId required" });
    }

    const reviews = await reviewsCollection
      .find({ bookId: new ObjectId(bookId) })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(reviews);
  } catch (e) {
    console.log("GET /reviews error:", e);
    res.status(500).send({ message: "Failed to fetch reviews" });
  }
});

    // Check eligibility: user must have ordered this book & not reviewed before
    app.get("/reviews/eligible/:bookId", verifyToken, async (req, res) => {
      try {
        const { bookId } = req.params;

        if (!ObjectId.isValid(bookId)) {
          return res
            .status(400)
            .send({ eligible: false, reason: "Invalid bookId" });
        }

        const email = normalizeEmail(req.user.email);

        const hasOrder = await ordersCollection.findOne({
          userEmail: email,
          bookId: new ObjectId(bookId),
          status: { $ne: "cancelled" },
        });

        if (!hasOrder) {
          return res.send({
            eligible: false,
            reason: "You must order this book first.",
          });
        }

        const already = await reviewsCollection.findOne({
          userEmail: email,
          bookId: new ObjectId(bookId),
        });

        if (already) {
          return res.send({
            eligible: false,
            reason: "You already reviewed this book.",
          });
        }

        res.send({ eligible: true });
      } catch (e) {
        console.log("GET /reviews/eligible error:", e);
        res.status(500).send({
          eligible: false,
          reason: "Server error",
        });
      }
    });

    // Add a review
    app.post("/reviews", verifyToken, async (req, res) => {
      try {
        const { bookId, rating, comment } = req.body;

        if (!bookId || !ObjectId.isValid(bookId)) {
          return res.status(400).send({ message: "Valid bookId required" });
        }

        const ratingNum = Number(rating);
        if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
          return res.status(400).send({ message: "Rating must be 1 to 5" });
        }

        const email = normalizeEmail(req.user.email);

        const hasOrder = await ordersCollection.findOne({
          userEmail: email,
          bookId: new ObjectId(bookId),
          status: { $ne: "cancelled" },
        });

        if (!hasOrder) {
          return res
            .status(403)
            .send({ message: "You must order this book to review it." });
        }

        const already = await reviewsCollection.findOne({
          userEmail: email,
          bookId: new ObjectId(bookId),
        });

        if (already) {
          return res
            .status(400)
            .send({ message: "You already reviewed this book." });
        }

        const reviewDoc = {
          bookId: new ObjectId(bookId),
          userEmail: email,
          userName: req.user?.name || req.user?.displayName || "User",
          userPhoto: req.user?.picture || req.user?.photoURL || "",
          rating: ratingNum,
          comment: (comment || "").trim(),
          createdAt: new Date(),
        };

        const result = await reviewsCollection.insertOne(reviewDoc);

        const stats = await recalcBookRating(bookId);

        res.send({ insertedId: result.insertedId, ...stats });
      } catch (e) {
        console.log("POST /reviews error:", e);

        if (e?.code === 11000) {
          return res
            .status(400)
            .send({ message: "You already reviewed this book." });
        }

        res.status(500).send({ message: "Failed to submit review" });
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

        if (order.userEmail !== email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        if (order.status !== "pending") {
          return res
            .status(400)
            .send({ message: "Only pending orders can be cancelled" });
        }

        if (order.paymentStatus === "paid") {
          return res
            .status(400)
            .send({ message: "Paid orders cannot be cancelled" });
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

    // Pay order (simulation) => create payment record
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

    app.get(
      "/librarian/orders",
      verifyToken,
      requireRole(usersCollection, ["librarian", "admin"]),
      async (req, res) => {
        try {
          const librarianEmail = normalizeEmail(req.user.email);
          const role = await getUserRole(usersCollection, librarianEmail);

          const matchStage =
            role === "admin"
              ? {}
              : { "bookData.librarianEmail": librarianEmail };

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

          if (
            !["pending", "shipped", "delivered", "cancelled"].includes(status)
          ) {
            return res.status(400).send({ message: "Invalid status" });
          }

          const order = await ordersCollection.findOne({
            _id: new ObjectId(id),
          });
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

    app.patch(
      "/librarian/orders/:id/cancel",
      verifyToken,
      requireRole(usersCollection, ["librarian", "admin"]),
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid order id" });
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
            { $set: { status: "cancelled" } }
          );

          res.send(result);
        } catch (e) {
          res.status(500).send({ message: "Failed to cancel order" });
        }
      }
    );

    // =====================================================
    // PAYMENTS + INVOICES
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

    // Invoices for logged-in user (payments + orders + books)
    app.get("/invoices/my", verifyToken, async (req, res) => {
      try {
        const email = normalizeEmail(req.user.email);

        const result = await paymentsCollection
          .aggregate([
            { $match: { userEmail: email } },

            {
              $lookup: {
                from: "orders",
                localField: "orderId",
                foreignField: "_id",
                as: "order",
              },
            },
            { $unwind: { path: "$order", preserveNullAndEmptyArrays: true } },

            {
              $lookup: {
                from: "books",
                localField: "order.bookId",
                foreignField: "_id",
                as: "book",
              },
            },
            { $unwind: { path: "$book", preserveNullAndEmptyArrays: true } },

            { $sort: { date: -1 } },

            {
              $project: {
                _id: 1,
                paymentId: 1,
                amount: 1,
                date: 1,
                orderId: 1,
                orderStatus: "$order.status",
                paymentStatus: "$order.paymentStatus",
                bookId: "$order.bookId",
                bookName: { $ifNull: ["$book.name", "$order.bookName"] },
                bookImage: { $ifNull: ["$book.image", "$order.bookImage"] },
                bookAuthor: { $ifNull: ["$book.author", ""] },
                price: { $ifNull: ["$book.price", "$order.price"] },
              },
            },
          ])
          .toArray();

        res.send(result);
      } catch (e) {
        console.log("GET /invoices/my error:", e);
        res.status(500).send({ message: "Failed to fetch invoices" });
      }
    });

    // =====================================================
    // WISHLIST
    // =====================================================

    app.post("/wishlist", verifyToken, async (req, res) => {
      try {
        const data = req.body;

        if (!data?.bookId) {
          return res.status(400).send({ message: "bookId required" });
        }
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

        const result = await wishlistCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (e) {
        res.status(500).send({ message: "Failed to remove" });
      }
    });

    console.log("Routes loaded");
  } catch (error) {
    console.error("run() error:", error);
  }
}

run().catch(console.dir);

// Start locally only
if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    console.log(`BookOrbit server running on port ${port}`);
  });
}

// Export for Vercel
module.exports = app;