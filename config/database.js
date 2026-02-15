const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
  try {
    // Note: useNewUrlParser et useUnifiedTopology sont dépréciés depuis Mongoose 6+
    // Ces options n'ont plus d'effet et génèrent des warnings
    const conn = await mongoose.connect(process.env.MONGODB_URI);

    console.log(`MongoDB connecté: ${conn.connection.host}`);
  } catch (error) {
    console.error('Erreur de connexion MongoDB:', error);
    process.exit(1);
  }
};

module.exports = connectDB; 