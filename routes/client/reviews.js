const express = require("express");
const router = express.Router();
const mongo = require("../../lib/mongo");
const { ObjectId } = require("mongodb");

// Get reviews for an accommodation
router.get("/:accommodationId", async (req, res, next) => {
  try {
    const accommodationId = req.params.accommodationId;
    const col = await mongo.getCollection("reviews");
    
    const reviews = await col.find({ accommodationId }).sort({ createdAt: -1 }).toArray();
    
    // Calculate average rating
    const totalRating = reviews.reduce((sum, review) => sum + review.rating, 0);
    const averageRating = reviews.length > 0 ? (totalRating / reviews.length).toFixed(1) : 0;

    res.status(200).json({
      status: "success",
      summary: {
        totalReviews: reviews.length,
        averageRating: parseFloat(averageRating)
      },
      reviews,
    });
  } catch (err) {
    next(err);
  }
});

// Post a new review
router.post("/", async (req, res, next) => {
  try {
    const { accommodationId, userId, userName, rating, comment } = req.body;
    
    if (!accommodationId || !rating) {
      return res.status(400).json({ error: "accommodationId and rating are required" });
    }

    const numericRating = Number(rating);
    if (numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ error: "rating must be between 1 and 5" });
    }

    // Ensure only Homestays can receive reviews
    const accCol = await mongo.getCollection("accomodations");
    const accommodation = await accCol.findOne({ _id: new ObjectId(accommodationId) });
    
    if (!accommodation) {
      return res.status(404).json({ error: "Accommodation not found" });
    }

    if (accommodation.type?.toLowerCase() !== "homestay") {
      return res.status(403).json({ error: "Reviews are only allowed for Homestay properties" });
    }

    const col = await mongo.getCollection("reviews");
    const newReview = {
      accommodationId,
      userId: userId || "anonymous",
      userName: userName || "Guest",
      rating: numericRating,
      comment: comment || "",
      createdAt: new Date()
    };

    const result = await col.insertOne(newReview);

    res.status(201).json({
      status: "success",
      message: "Review submitted successfully",
      review: { _id: result.insertedId, ...newReview }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
