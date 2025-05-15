const fs = require("fs");
const path = require("path");
const swaggerJsdoc = require("swagger-jsdoc");
const SwaggerParser = require("swagger-parser");

const contracts = {
  DTAIOCToken: "0xB0f1D7Cf1821557271C01F2e560d3B397Fe9ed3c",
  DTAIOCNFT: "0xFCadE10a83E0963C31e8F9EB1712AE4AeC422FD1",
  DTAIOCStaking: "0xf5d48836E1FDf267294Ca6B1B6f3860c18eF75dC",
  IBasenameResolver: "0xE2d6C0aF79bf5CA534B591B5A86bd467B308aB8F",
  DTAIOCGame: "0xA6d6A60eaA5F52b60843deFFF560F788E7C44d78",
  PlatformAddress: "0x37706dAb5DA56EcCa562f4f26478d1C484f0A7fB",
};

function loadLocalAbi(contractName) {
  const abiPath = path.join(__dirname, "../abis", `${contractName}.json`);
  if (!fs.existsSync(abiPath)) {
    console.error(`ABI file for ${contractName} not found at ${abiPath}`);
    return null;
  }
  try {
    const abiData = JSON.parse(fs.readFileSync(abiPath, "utf8"));
    return Array.isArray(abiData) ? abiData : abiData.abi || null;
  } catch (error) {
    console.error(`Error reading ABI for ${contractName}: ${error.message}`);
    return null;
  }
}

async function generateOpenApi() {
  // Initialize OpenAPI spec with Express routes and security schemes
  const swaggerOptions = {
    definition: {
      openapi: "3.0.0",
      info: {
        title: "DTriviaAIOnChain API",
        version: "1.0.0",
        description: "API for DTriviaAIOnChain game platform with blockchain integration",
      },
      servers: [{ url: "https://dtaioc-aimodel-1.onrender.com" }],
      security: [
        {
          oauth2: [], // Apply OAuth2 to endpoints where specified
        },
      ],
      components: {
        securitySchemes: {
          oauth2: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://api.twitter.com/2/oauth2/authorize",
                tokenUrl: "https://api.twitter.com/2/oauth2/token",
                scopes: {
                  "tweet.read": "Read tweets",
                  "users.read": "Read user info",
                  "offline.access": "Obtain refresh token",
                },
              },
            },
          },
        },
      },
    },
    apis: [path.join(__dirname, "../server.js")], // Scan server.js for JSDoc
  };
  const openApiSpec = swaggerJsdoc(swaggerOptions);

  // Add contract-based paths
  for (const [name, address] of Object.entries(contracts)) {
    const abi = loadLocalAbi(name);
    if (!abi || !Array.isArray(abi)) {
      console.error(`Skipping ${name}: Invalid or missing ABI`);
      continue;
    }
    abi.forEach((item) => {
      if (item.type === "function" && item.stateMutability !== "pure") {
        const path = `/contract/${address}/${item.name}`;
        const method = item.stateMutability === "view" ? "get" : "post";
        const parameters = item.inputs.map((input, idx) => ({
          in: method === "get" ? "query" : "body",
          name: input.name || `param${idx}`,
          schema: { type: input.type },
          required: true,
        }));

        openApiSpec.paths[path] = openApiSpec.paths[path] || {};
        openApiSpec.paths[path][method] = {
          summary: `Call ${name}.${item.name}`,
          description: `Interact with ${name} contract at ${address}`,
          parameters: method === "get" ? parameters : [],
          requestBody:
            method === "post"
              ? {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: Object.fromEntries(
                          parameters.map((p) => [p.name, { type: p.schema.type }])
                        ),
                        required: parameters.map((p) => p.name),
                      },
                    },
                  },
                }
              : undefined,
          responses: {
            200: { description: "Successful contract interaction" },
            400: { description: "Invalid input parameters" },
            500: { description: "Server or blockchain error" },
          },
        };
      }
    });
  }

  // Validate OpenAPI spec
  try {
    await SwaggerParser.validate(openApiSpec);
    console.log("OpenAPI spec is valid");
  } catch (error) {
    console.error("Invalid OpenAPI spec:", error.message);
    throw error;
  }

  // Write to openapi.json
  const outputPath = path.join(__dirname, "../openapi.json");
  fs.writeFileSync(outputPath, JSON.stringify(openApiSpec, null, 2));
  console.log(`OpenAPI spec generated at ${outputPath}`);
}

generateOpenApi().catch((error) => {
  console.error("Error generating OpenAPI spec:", error.message);
  process.exit(1);
});