const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ✅ middleware
app.use(cors({
  origin: ["http://localhost:5173"], // add deployed client URL later
  credentials: true,
}));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("BookOrbit server is running ");
});


async function run() {
  try {
    const db = client.db("bookorbitDB");

    const usersCollection = db.collection("users");
    const booksCollection = db.collection("books");
    const ordersCollection = db.collection("orders");
    const paymentsCollection = db.collection("payments");

    // test mongo
    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB Connected!");

    
  } finally {
    
  }
}
run().catch(console.dir);


app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
