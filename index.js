const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;
require('dotenv').config();

app.use(cors());
app.use(express.json());

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const uri = process.env.MONGO_DB_URL

app.get('/', (req, res) => {
    res.send('server is running');
});

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const database = client.db("cooksphere");
        const recipesCollection = database.collection("recipes");

        app.post('/recipes', async (req, res) => {
            const recipe = req.body;
            const result = await recipesCollection.insertOne(recipe);
            res.send(result);
        });

        app.get('/recipes', async (req, res) => {
            const { category, authorEmail, page = 1, limit = 12 } = req.query;
            let query = {};
            if (category) {
                query.category = { $in: category.split(',') };
            }
            if (authorEmail) {
                query.authorEmail = authorEmail;
            }
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const recipes = await recipesCollection.find(query).skip(skip).limit(parseInt(limit)).toArray();
            const total = await recipesCollection.countDocuments(query);
            res.send({ recipes, total });
        });

        app.get('/admin/stats', async (req, res) => {
            const totalRecipes = await recipesCollection.countDocuments();
            const totalUsers = await database.collection("user").countDocuments();
            res.send({ totalRecipes, totalUsers });
        });

        app.delete('/recipes/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await recipesCollection.deleteOne(query);
            res.send(result);
        });


        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } catch (error) {
        console.error(error);
    }
}
run().catch(console.dir);


app.listen(port, () => {
    console.log(`server is running on port ${port}`);
});