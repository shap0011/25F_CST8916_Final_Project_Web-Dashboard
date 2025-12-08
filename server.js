/**
 * Rideau Canal Monitoring Dashboard - Backend Server (FINAL)
 * Serves the dashboard and provides API endpoints for real-time data
 */

const express = require("express");
const { CosmosClient } = require("@azure/cosmos");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Location mapping: pretty name (UI) <-> slug (Cosmos)
const LOCATION_LABELS = ["Dow's Lake", "Fifth Avenue", "NAC"];
const LOCATION_SLUGS = {
  "Dow's Lake": "dows-lake",
  "Fifth Avenue": "fifth-avenue",
  NAC: "nac",
};

function labelToSlug(label) {
  return LOCATION_SLUGS[label] || label;
}

// Ensure docs have windowEndTime for sorting / charts
function normalizeTimestamps(docs) {
  docs.forEach((doc) => {
    if (!doc.windowEndTime && doc.windowEnd) {
      doc.windowEndTime = doc.windowEnd;
    }
  });
  return docs;
}

// Initialize Cosmos DB Client
const cosmosClient = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY,
});

const database = cosmosClient.database(process.env.COSMOS_DATABASE);
const container = database.container(process.env.COSMOS_CONTAINER);

/**
 * API Endpoint: Get latest readings for all locations
 * Returns fields expected by frontend:
 *  - location (pretty name)
 *  - avgIceThickness
 *  - avgSurfaceTemperature
 *  - maxSnowAccumulation
 *  - safetyStatus
 *  - windowEndTime
 */
app.get("/api/latest", async (req, res) => {
  try {
    const results = [];

    for (const label of LOCATION_LABELS) {
      const slug = labelToSlug(label);

      const querySpec = {
        query: "SELECT * FROM c WHERE c.location = @location",
        parameters: [{ name: "@location", value: slug }],
      };

      const { resources } = await container.items.query(querySpec).fetchAll();
      normalizeTimestamps(resources);

      if (resources.length > 0) {
        // latest doc for this location
        resources.sort(
          (a, b) => new Date(b.windowEndTime) - new Date(a.windowEndTime)
        );
        const latest = resources[0];

        // Shape data to what the frontend expects
        results.push({
          location: label, // pretty name for UI
          safetyStatus: latest.safetyStatus,
          windowEndTime: latest.windowEndTime,
          avgIceThickness: latest.avgIceThicknessCm,
          avgSurfaceTemperature: latest.avgSurfaceTemperatureC,
          maxSnowAccumulation: latest.maxSnowAccumulationCm,
          avgExternalTemperature: latest.avgExternalTemperatureC,
          readingCount: latest.readingCount,
        });
      }
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      data: results,
    });
  } catch (error) {
    console.error("Error fetching latest data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch latest data",
    });
  }
});

/**
 * API Endpoint: Get historical data for a specific location (pretty name)
 * Frontend calls /api/history/{locationLabel}?limit=12
 */
app.get("/api/history/:location", async (req, res) => {
  try {
    const prettyLocation = decodeURIComponent(req.params.location);
    const slug = labelToSlug(prettyLocation);
    const limit = parseInt(req.query.limit) || 12;

    const querySpec = {
      query: "SELECT * FROM c WHERE c.location = @location",
      parameters: [{ name: "@location", value: slug }],
    };

    const { resources } = await container.items.query(querySpec).fetchAll();
    normalizeTimestamps(resources);

    // Sort latest-first
    resources.sort(
      (a, b) => new Date(b.windowEndTime) - new Date(a.windowEndTime)
    );

    const limited = resources.slice(0, limit);

    // Map to shape expected by frontend charts
    const history = limited
      .slice() // copy
      .reverse() // oldest → newest for chart X-axis
      .map((doc) => ({
        location: prettyLocation,
        windowEndTime: doc.windowEndTime,
        avgIceThickness: doc.avgIceThicknessCm,
        avgSurfaceTemperature: doc.avgSurfaceTemperatureC,
        maxSnowAccumulation: doc.maxSnowAccumulationCm,
        safetyStatus: doc.safetyStatus,
      }));

    res.json({
      success: true,
      location: prettyLocation,
      data: history,
    });
  } catch (error) {
    console.error("Error fetching history:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch historical data",
    });
  }
});

/**
 * API Endpoint: Get overall system status
 */
app.get("/api/status", async (req, res) => {
  try {
    const statuses = [];

    for (const label of LOCATION_LABELS) {
      const slug = labelToSlug(label);

      const querySpec = {
        query:
          "SELECT c.location, c.safetyStatus, c.windowEnd AS windowEnd FROM c WHERE c.location = @location",
        parameters: [{ name: "@location", value: slug }],
      };

      const { resources } = await container.items.query(querySpec).fetchAll();
      normalizeTimestamps(resources);

      if (resources.length > 0) {
        resources.sort(
          (a, b) => new Date(b.windowEndTime) - new Date(a.windowEndTime)
        );
        const latest = resources[0];

        statuses.push({
          location: label,
          safetyStatus: latest.safetyStatus,
          windowEndTime: latest.windowEndTime,
        });
      }
    }

    const overallStatus = statuses.every((s) => s.safetyStatus === "Safe")
      ? "Safe"
      : statuses.some((s) => s.safetyStatus === "Unsafe")
      ? "Unsafe"
      : "Caution";

    res.json({
      success: true,
      overallStatus,
      locations: statuses,
    });
  } catch (error) {
    console.error("Error fetching status:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch system status",
    });
  }
});

/**
 * API Endpoint: Get all raw data (for debugging)
 */
app.get("/api/all", async (req, res) => {
  try {
    const querySpec = { query: "SELECT * FROM c" };

    const { resources } = await container.items.query(querySpec).fetchAll();
    normalizeTimestamps(resources);

    resources.sort(
      (a, b) => new Date(b.windowEndTime) - new Date(a.windowEndTime)
    );

    res.json({
      success: true,
      count: resources.length,
      data: resources,
    });
  } catch (error) {
    console.error("Error fetching all data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch all data",
    });
  }
});

/**
 * Serve the dashboard
 */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/**
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    cosmosdb: {
      endpoint: process.env.COSMOS_ENDPOINT ? "configured" : "missing",
      database: process.env.COSMOS_DATABASE,
      container: process.env.COSMOS_CONTAINER,
    },
  });
});

// Start server
app.listen(port, () => {
  console.log(
    `🚀 Rideau Canal Dashboard server running on http://localhost:${port}`
  );
  console.log(`📊 API endpoints at http://localhost:${port}/api/...`);
  console.log(`🏥 Health: http://localhost:${port}/health`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down server...");
  process.exit(0);
});
