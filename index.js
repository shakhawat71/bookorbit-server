// ✅ server/index.js (FULL FILE - copy/paste)
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
    origin: [
      "http://localhost:5173",
      // add your deployed client url here later:
      // "https://your-live-site.netlify.app"
    ],
    credentials: true,
  })
);
app.use(express.json());

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

// ===============================
// Helpers
// ===============================
const getUserRole = async (usersCollection, email) => {
  const u = await usersCollection.findOne({ email });
  return u?.role || "user";
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
          updatedAt: new Date(),
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

    // ✅ Admin: get all users
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

    // ✅ Admin: update user role
    app.patch(
      "/users/role/:email",
      verifyToken,
      requireRole(usersCollection, ["admin"]),
      async (req, res) => {
        try {
          const { email } = req.params;
          const { role } = req.body;

          if (!["user", "librarian", "admin"].includes(role)) {
            return res.status(400).send({ message: "Invalid role" });
          }

          const result = await usersCollection.updateOne(
            { email },
            { $set: { role } }
          );
          res.send(result);
        } catch (e) {
          res.status(500).send({ message: "Failed to update role" });
        }
      }
    );

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

    // Add Book (Librarian/Admin)
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
      }
    );

    // ✅ Get my books (Librarian/Admin)  (KEEP THIS BEFORE /books/:id)
    app.get(
      "/books/mine",
      verifyToken,
      requireRole(usersCollection, ["librarian", "admin"]),
      async (req, res) => {
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
      }
    );

    // ✅ Admin: get all books
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

    // ✅ Admin: publish/unpublish
    app.patch(
      "/admin/books/:id/status",
      verifyToken,
      requireRole(usersCollection, ["admin"]),
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body;

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

    // ✅ Public books (published only) - supports query: /books?status=published
    app.get("/books", async (req, res) => {
      try {
        const { status } = req.query;

        let query = {};
        if (status === "published") query.status = "published";

        const result = await booksCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.error("GET /books error:", error);
        res.status(500).send({ message: "Failed to fetch books" });
      }
    });

    // ✅ Get single book by id
    app.get("/books/:id", async (req, res) => {
      try {
        const { id } = req.params;

        // guard invalid object id
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid book id" });
        }

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

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid book id" });
        }

        const book = await booksCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!book) return res.status(404).send({ message: "Book not found" });

        const role = await getUserRole(usersCollection, req.user.email);

        if (role !== "admin" && book.librarianEmail !== req.user.email) {
          return res.status(403).send({ message: "Forbidden" });
        }

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

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid book id" });
        }

        const book = await booksCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!book) return res.status(404).send({ message: "Book not found" });

        const role = await getUserRole(usersCollection, req.user.email);

        if (role !== "admin" && book.librarianEmail !== req.user.email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        await booksCollection.deleteOne({
          _id: new ObjectId(id),
        });

        // requirement: deleting book deletes all orders of that book
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

    // Get single order by id (User) - for payment/details
    app.get("/orders/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid order id" });
        }

        const order = await ordersCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!order) return res.status(404).send({ message: "Order not found" });

        if (order.userEmail !== req.user.email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        res.send(order);
      } catch (error) {
        console.error("GET /orders/:id error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Cancel order (User) - only if pending
    app.patch("/orders/:id/cancel", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const email = req.user.email;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid order id" });
        }

        const order = await ordersCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!order) return res.status(404).send({ message: "Order not found" });

        if (order.userEmail !== email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        if (order.status !== "pending") {
          return res
            .status(400)
            .send({ message: "Only pending orders can be cancelled" });
        }

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

    // Pay for an order (User) - simple payment simulation
    app.patch("/orders/:id/pay", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid order id" });
        }

        const order = await ordersCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!order) return res.status(404).send({ message: "Order not found" });

        if (order.userEmail !== req.user.email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        if (order.status !== "pending") {
          return res.status(400).send({ message: "Only pending orders can be paid" });
        }

        if (order.paymentStatus === "paid") {
          return res.status(400).send({ message: "Already paid" });
        }

        await ordersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              paymentStatus: "paid",
              paidAt: new Date(),
            },
          }
        );

        await paymentsCollection.insertOne({
          orderId: new ObjectId(id),
          userEmail: req.user.email,
          amount: Number(order.price || 0),
          paymentId: `PAY-${Date.now()}`,
          date: new Date(),
        });

        res.send({ message: "Payment successful" });
      } catch (error) {
        console.error("PATCH /orders/:id/pay error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // =====================================================
    // ORDERS (Librarian/Admin)
    // =====================================================

    // Librarian sees all orders for books they added
    app.get(
      "/librarian/orders",
      verifyToken,
      requireRole(usersCollection, ["librarian", "admin"]),
      async (req, res) => {
        try {
          const librarianEmail = req.user.email;
          const role = await getUserRole(usersCollection, librarianEmail);

          const matchStage =
            role === "admin"
              ? {} // admin sees all orders
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
        } catch (error) {
          console.error("GET /librarian/orders error:", error);
          res.status(500).send({ message: "Failed to fetch librarian orders" });
        }
      }
    );

    // Librarian/Admin: update order status (pending->shipped->delivered)
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

          // load order + book to verify ownership (unless admin)
          const order = await ordersCollection.findOne({ _id: new ObjectId(id) });
          if (!order) return res.status(404).send({ message: "Order not found" });

          const role = await getUserRole(usersCollection, req.user.email);
          if (role !== "admin") {
            const book = await booksCollection.findOne({ _id: order.bookId });
            if (!book) return res.status(404).send({ message: "Book not found" });
            if (book.librarianEmail !== req.user.email) {
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

    // Librarian/Admin: cancel an order
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
            if (book.librarianEmail !== req.user.email) {
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
    // PAYMENTS (User) - list invoices
    // =====================================================
    app.get("/payments/my", verifyToken, async (req, res) => {
      try {
        const result = await paymentsCollection
          .find({ userEmail: req.user.email })
          .sort({ date: -1 })
          .toArray();
        res.send(result);
      } catch (e) {
        res.status(500).send({ message: "Failed to fetch payments" });
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