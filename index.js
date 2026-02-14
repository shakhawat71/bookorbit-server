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

// MongoDB URI
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("bookorbitDB");

    const usersCollection = db.collection("users");
    const booksCollection = db.collection("books");
    const ordersCollection = db.collection("orders");
    const paymentsCollection = db.collection("payments");

    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB Connected!");

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

    // ===============================
    // CREATE ORDER
    // ===============================

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
        res.status(500).send({ message: "Server error" });
      }
    });

    // ===============================
    // GET MY ORDERS (🔥 THIS FIXES 404)
    // ===============================

    app.get("/orders/my", verifyToken, async (req, res) => {
      try {
        const email = req.user.email;

        const result = await ordersCollection
          .find({ userEmail: email })
          .sort({ orderDate: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Server error" });
      }
    });



    // ===============================
    // CANCEL ORDER
    // ===============================

    app.patch("/orders/:id/cancel", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const email = req.user.email;

        const order = await ordersCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!order)
          return res.status(404).send({ message: "Order not found" });

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
        res.status(500).send({ message: "Server error" });
      }
    });

  } catch (error) {
    console.error(error);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
