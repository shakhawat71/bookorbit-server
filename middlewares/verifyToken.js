const admin = require("../firebaseAdmin");

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send({ message: "Unauthorized access" });
    }

    const token = authHeader.split(" ")[1];

    const decoded = await admin.auth().verifyIdToken(token);

    req.user = decoded; // contains email, uid, etc.
    next();
  } catch (error) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
};

module.exports = verifyToken;
