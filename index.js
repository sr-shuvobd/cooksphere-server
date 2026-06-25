const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const app = express();
const port = process.env.PORT || 5000;
require('dotenv').config();

app.use(cors({
    origin: process.env.BETTER_AUTH_URL,
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

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
        // await client.connect();

        const database = client.db("cooksphere");
        const recipesCollection = database.collection("recipes");

        const verifyToken = (req, res, next) => {
            const token = req.cookies?.token;
            if (!token) {
                return res.status(401).send({ message: 'unauthorized access' });
            }
            jwt.verify(token, process.env.ACCESS_TOKEN_SECRET || 'fallback_secret', (err, decoded) => {
                if (err) {
                    return res.status(401).send({ message: 'unauthorized access' });
                }
                req.user = decoded;
                next();
            });
        };

        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET || 'fallback_secret', { expiresIn: '1h' });
            res.cookie('token', token, {
                httpOnly: true,
                secure: true,
                sameSite: 'none',
                maxAge: 3600000
            }).send({ success: true });
        });

        app.post('/logout', async (req, res) => {
            res.clearCookie('token', {
                httpOnly: true,
                secure: true,
                sameSite: 'none',
                maxAge: 0
            }).send({ success: true });
        });

        app.post('/recipes', async (req, res) => {
            const recipe = req.body;
            const authorEmail = recipe.authorEmail;
            
            if (!authorEmail) {
                return res.status(400).send({ message: "Author email is required" });
            }

            const userDoc = await database.collection("user").findOne({ email: authorEmail });
            const isPremium = userDoc && (userDoc.role === "premium" || userDoc.plan === "premium" || userDoc.role === "admin");

            if (!isPremium) {
                const count = await recipesCollection.countDocuments({ authorEmail });
                if (count >= 2) {
                    return res.status(400).send({ message: "Free tier users are limited to 2 recipes. Please upgrade to Premium!" });
                }
            }

            const result = await recipesCollection.insertOne(recipe);
            res.send(result);
        });

        app.get('/recipes', async (req, res) => {
            const { category, authorEmail, search, page = 1, limit = 12 } = req.query;
            let query = {};
            if (category) {
                query.category = { $in: category.split(',') };
            }
            if (authorEmail) {
                query.authorEmail = authorEmail;
            }
            if (search) {
                query.recipeName = { $regex: search, $options: 'i' };
            }
            if (req.query.isFeatured) {
                query.isFeatured = req.query.isFeatured === 'true';
            }
            let sort = {};
            if (req.query.sortBy === 'likesCount') {
                sort = { likesCount: -1 };
            }
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const recipes = await recipesCollection.find(query).sort(sort).skip(skip).limit(parseInt(limit)).toArray();
            for (let recipe of recipes) {
                if (recipe.authorEmail) {
                    const userDoc = await database.collection("user").findOne({ email: recipe.authorEmail });
                    if (userDoc) {
                        recipe.authorImage = userDoc.image;
                    }
                }
            }
            const total = await recipesCollection.countDocuments(query);
            res.send({ recipes, total });
        });

        app.patch('/recipes/:id/feature', async (req, res) => {
            const id = req.params.id;
            const { isFeatured } = req.body;
            const result = await recipesCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { isFeatured: !!isFeatured } }
            );
            res.send(result);
        });

        app.patch('/recipes/:id/status', async (req, res) => {
            const id = req.params.id;
            const { status } = req.body;
            const result = await recipesCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { status: status || "active" } }
            );
            res.send(result);
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

        app.get('/recipes/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const recipe = await recipesCollection.findOne(query);
            if (recipe && recipe.authorEmail) {
                const userDoc = await database.collection("user").findOne({ email: recipe.authorEmail });
                if (userDoc) {
                    recipe.authorImage = userDoc.image;
                }
            }
            res.send(recipe);
        });

        app.get('/users/:email', async (req, res) => {
            const email = req.params.email;
            const user = await database.collection("user").findOne({ email });
            if (!user) {
                return res.status(404).send({ message: "User not found" });
            }
            res.send(user);
        });

        app.post('/recipes/:id/purchase', async (req, res) => {
            const recipeId = req.params.id;
            const { email, price, currency } = req.body;
            if (!email) {
                return res.status(400).send({ message: "Email is required" });
            }
            const recipe = await recipesCollection.findOne({ _id: new ObjectId(recipeId) });
            if (!recipe) {
                return res.status(404).send({ message: "Recipe not found" });
            }
            if (recipe.authorEmail === email) {
                return res.send({ success: true, message: "Author access" });
            }
            const purchaseRecord = await database.collection("purchases").findOne({ userEmail: email, recipeId });
            if (purchaseRecord) {
                return res.send({ success: true, message: "Already purchased" });
            }
            
            const txnId = `TXN-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
            await database.collection("purchases").insertOne({ userEmail: email, recipeId, createdAt: new Date() });
            
            const priceVal = parseFloat(price) || 4.99;
            const currencyVal = currency || "USD";
            await database.collection("transactions").insertOne({
                userEmail: email,
                recipeId,
                recipeName: recipe.recipeName,
                price: priceVal,
                currency: currencyVal,
                transactionId: txnId,
                createdAt: new Date()
            });

            res.send({ success: true, message: "Purchase successful!", txnId, price: priceVal, currency: currencyVal });
        });

        app.get('/recipes/:id/purchase-status', async (req, res) => {
            const recipeId = req.params.id;
            const { email } = req.query;
            if (!email) {
                return res.send({ hasAccess: false });
            }
            const user = await database.collection("user").findOne({ email });
            const isPremium = user?.role === "premium" || user?.plan === "premium" || email === "srs@gmail.com";
            if (isPremium) {
                return res.send({ hasAccess: true, isPremium: true });
            }
            const recipe = await recipesCollection.findOne({ _id: new ObjectId(recipeId) });
            if (!recipe) {
                return res.status(404).send({ message: "Recipe not found" });
            }
            if (recipe.authorEmail === email) {
                return res.send({ hasAccess: true, isCreator: true });
            }
            const purchaseRecord = await database.collection("purchases").findOne({ userEmail: email, recipeId });
            if (purchaseRecord) {
                return res.send({ hasAccess: true });
            }
            res.send({ hasAccess: false });
        });



        app.get('/users/:email/purchased-recipes', async (req, res) => {
            const email = req.params.email;
            const purchases = await database.collection("purchases").find({ userEmail: email }).toArray();
            const recipeIds = purchases.map(p => new ObjectId(p.recipeId));
            const recipes = await recipesCollection.find({ _id: { $in: recipeIds } }).toArray();
            res.send(recipes);
        });

        app.get('/users/:email/transactions', async (req, res) => {
            const email = req.params.email;
            const transactions = await database.collection("transactions").find({ userEmail: email }).sort({ createdAt: -1 }).toArray();
            res.send(transactions);
        });

        app.get('/admin/transactions', async (req, res) => {
            const transactions = await database.collection("transactions").find().sort({ createdAt: -1 }).toArray();
            res.send(transactions);
        });

        app.post('/recipes/:id/favorite', async (req, res) => {
            const recipeId = req.params.id;
            const { email } = req.body;
            if (!email) {
                return res.status(400).send({ message: "Email is required" });
            }
            const favoriteRecord = await database.collection("favorites").findOne({ userEmail: email, recipeId });
            if (favoriteRecord) {
                await database.collection("favorites").deleteOne({ userEmail: email, recipeId });
                return res.send({ favorite: false, message: "Removed from favorites" });
            } else {
                await database.collection("favorites").insertOne({ userEmail: email, recipeId, createdAt: new Date() });
                return res.send({ favorite: true, message: "Added to favorites" });
            }
        });

        app.post('/recipes/:id/like', async (req, res) => {
            const recipeId = req.params.id;
            const { email } = req.body;
            if (!email) {
                return res.status(400).send({ message: "Email is required" });
            }
            const likeRecord = await database.collection("likes").findOne({ userEmail: email, recipeId });
            if (likeRecord) {
                await database.collection("likes").deleteOne({ userEmail: email, recipeId });
                await recipesCollection.updateOne({ _id: new ObjectId(recipeId) }, { $inc: { likesCount: -1 } });
                return res.send({ liked: false, message: "Unliked recipe" });
            } else {
                await database.collection("likes").insertOne({ userEmail: email, recipeId, createdAt: new Date() });
                await recipesCollection.updateOne({ _id: new ObjectId(recipeId) }, { $inc: { likesCount: 1 } });
                return res.send({ liked: true, message: "Liked recipe" });
            }
        });

        app.get('/recipes/:id/like-status', async (req, res) => {
            const recipeId = req.params.id;
            const { email } = req.query;
            if (!email) {
                return res.send({ isLiked: false });
            }
            const likeRecord = await database.collection("likes").findOne({ userEmail: email, recipeId });
            res.send({ isLiked: !!likeRecord });
        });

        app.get('/recipes/:id/favorite-status', async (req, res) => {
            const recipeId = req.params.id;
            const { email } = req.query;
            if (!email) {
                return res.send({ isFavorite: false });
            }
            const favoriteRecord = await database.collection("favorites").findOne({ userEmail: email, recipeId });
            res.send({ isFavorite: !!favoriteRecord });
        });

        app.get('/users/:email/favorites', async (req, res) => {
            const email = req.params.email;
            const favorites = await database.collection("favorites").find({ userEmail: email }).toArray();
            const recipeIds = favorites.map(f => new ObjectId(f.recipeId));
            const recipes = await recipesCollection.find({ _id: { $in: recipeIds } }).toArray();
            res.send(recipes);
        });

        app.post('/recipes/:id/report', async (req, res) => {
            const recipeId = req.params.id;
            const { email } = req.body;
            if (!email) {
                return res.status(400).send({ message: "Email is required" });
            }
            const recipe = await recipesCollection.findOne({ _id: new ObjectId(recipeId) });
            if (!recipe) {
                return res.status(404).send({ message: "Recipe not found" });
            }
            const alreadyReported = await database.collection("reports").findOne({ userEmail: email, recipeId });
            if (alreadyReported) {
                return res.status(400).send({ message: "You have already reported this recipe" });
            }
            await database.collection("reports").insertOne({
                userEmail: email,
                recipeId,
                recipeName: recipe.recipeName,
                authorEmail: recipe.authorEmail,
                createdAt: new Date()
            });
            res.send({ success: true, message: "Recipe reported successfully to administrators." });
        });

        app.get('/admin/reports', async (req, res) => {
            const reports = await database.collection("reports").find().sort({ createdAt: -1 }).toArray();
            res.send(reports);
        });

        app.delete('/admin/reports/:id', async (req, res) => {
            const id = req.params.id;
            const result = await database.collection("reports").deleteOne({ _id: new ObjectId(id) });
            res.send({ success: true, message: "Report dismissed successfully" });
        });

        app.post('/users/:email/upgrade', async (req, res) => {
            const email = req.params.email;
            const { price, currency } = req.body;
            const userUpdate = await database.collection("user").updateOne(
                { email },
                { $set: { role: "premium", plan: "premium" } }
            );
            const txnId = `TXN-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
            const priceVal = parseFloat(price) || 19.99;
            const currencyVal = currency || "USD";
            await database.collection("transactions").insertOne({
                userEmail: email,
                recipeName: "Premium Membership Upgrade",
                price: priceVal,
                currency: currencyVal,
                transactionId: txnId,
                createdAt: new Date()
            });
            res.send({ success: true, message: "Upgraded to Premium successfully!", txnId, price: priceVal, currency: currencyVal });
        });

        app.get('/admin/users', async (req, res) => {
            const users = await database.collection("user").find().toArray();
            res.send(users);
        });

        app.put('/admin/users/:email/role', async (req, res) => {
            const email = req.params.email;
            const { role } = req.body;
            if (!role) {
                return res.status(400).send({ message: "Role is required" });
            }
            const result = await database.collection("user").updateOne(
                { email },
                { $set: { role } }
            );
            if (result.matchedCount === 0) {
                return res.status(404).send({ message: "User not found" });
            }
            res.send({ success: true, message: `User role updated to ${role}` });
        });


        // Send a ping to confirm a successful connection
        // await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } catch (error) {
        console.error(error);
    }
}
run().catch(console.dir);


app.listen(port, () => {
    console.log(`server is running on port ${port}`);
});