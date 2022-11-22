const express = require('express');
const app = express();
require('dotenv').config();
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const port = process.env.PORT || 5000;
const stripe = require('stripe')(process.env.STRIPE_SECRET);

// middleware
app.use(cors());
app.use(express.json());

// mongodb

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ufdxsbo.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

// jwt middleware
const verifyJwt = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ access: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
    if (err) {
      return res.status(403).send({ message: 'forbidden access' });
    }
    req.decoded = decoded;
    next();
  })

}

const dbConnect = async () => {
  try {
    await client.connect();
    console.log('MongoDB connected');
  } catch (error) {
    console.log(error.name, error.message);
  }
};

dbConnect();

const appointmentOptionCollection = client.db('doctorsPortal').collection('appointmentOptions');
const bookingsCollection = client.db('doctorsPortal').collection('bookings');
const usersCollection = client.db('doctorsPortal').collection('users');
const doctorsCollection = client.db('doctorsPortal').collection('doctors');
const paymentsCollection = client.db('doctorsPortal').collection('payments');

// NOTE: make sure you use verify admin after verify jwt
const verifyAdmin = async (req, res, next) => {
  // console.log('inside verify admin', req.decoded.email);
  const decodedEmail = req.decoded.email;
  const query = { email: decodedEmail };
  const user = await usersCollection.findOne(query);
  if (user?.role !== 'admin') {
    return res.status(403).send({ message: 'forbidden access' });
  }
  next();
}


// appointment options get
// use aggregate to query multiple collection and then merge data
app.get('/appointmentOptions', async (req, res) => {
  try {
    const date = req.query.date;
    console.log(date);
    const query = {};
    const options = await appointmentOptionCollection.find(query).toArray();

    // get the bookings of the provided date
    const bookingQuery = { appointmentDate: date };
    const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray();

    options.forEach(option => {
      const optionBooked = alreadyBooked.filter(book => book.treatment === option.name);
      const bookedSlots = optionBooked.map(book => book.slot);
      const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot));
      option.slots = remainingSlots;
      console.log(date, option.name, remainingSlots.length);
    })

    res.send(options);
  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
});

// different system
app.get('/v2/appointmentOptions', async (req, res) => {
  try {
    const date = req.query.date;
    const options = await appointmentOptionCollection.aggregate([
      {
        $lookup: {
          from: 'bookings',
          localField: 'name',
          foreignField: 'treatment',
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ['$appointmentDate', date]
                }
              }
            }
          ],
          as: 'booked'
        }
      },
      {
        $project: {
          name: 1,
          slots: 1,
          price: 1,
          booked: {
            $map: {
              input: '$booked',
              as: 'book',
              in: '$$book.slot'
            }
          }
        }
      },
      {
        $project: {
          name: 1,
          price: 1,
          slots: {
            $setDifference: ['$slots', '$booked']
          }
        }
      }
    ]).toArray();

    res.send(options);

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
})

// bookings get

app.get('/bookings', verifyJwt, async (req, res) => {
  try {
    const email = req.query.email;
    const decodedEmail = req.decoded.email;

    if (email !== decodedEmail) {
      return res.status(403).send({ message: 'forbidden access' });
    }

    const query = { email: email };
    const bookings = await bookingsCollection.find(query).toArray();

    res.send(bookings);

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
});

app.get('/bookings/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const query = { _id: ObjectId(id) };
    const booking = await bookingsCollection.findOne(query);

    res.send(booking);

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
})

// bookings get
app.post('/bookings', async (req, res) => {
  try {
    const booking = req.body;
    console.log(booking);

    const query = {
      appointmentDate: booking.appointmentDate,
      email: booking.email,
      treatment: booking.treatment
    }

    const alreadyBooked = await bookingsCollection.find(query).toArray();

    if (alreadyBooked.length) {
      const message = `You already have a booking on ${booking.appointmentDate}`;
      return res.send({ acknowledged: false, message });
    }

    const result = await bookingsCollection.insertOne(booking);
    res.send(result);

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
});

// stripe payment
app.post('/create-payment-intent', async (req, res) => {
  try {
    const booking = req.body;
    const price = booking.price;
    const amount = price * 1000;

    const paymentIntent = await stripe.paymentIntents.create({
      currency: 'usd',
      amount: amount,
      "payment_method_types": [
        "card"
      ],
    })
    res.send({
      clientSecret: paymentIntent.client_secret,
    })

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
});

app.post('/payments', async (req, res) => {
  try {
    const payment = req.body;
    const result = await paymentsCollection.insertOne(payment);
    const id = payment.bookingId;
    const filter = { _id: ObjectId(id) };
    const updatedDoc = {
      $set: {
        paid: true,
        transactionId: payment.transactionId
      }
    };
    const updatedResult = await bookingsCollection.updateOne(filter, updatedDoc);
    res.send({result, updatedResult});

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
})

// jwt
app.get('/jwt', async (req, res) => {
  try {
    const email = req.query.email;
    const query = { email: email };
    const user = await usersCollection.findOne(query);

    if (user) {
      const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, {
        expiresIn: '1d'
      });
      return res.send({ accessToken: token });
    }
    res.status(403).send({ accessToken: 'forbidden' });

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
});


// post users
app.post('/users', async (req, res) => {
  try {
    const user = req.body;
    const result = await usersCollection.insertOne(user);

    res.send(result);

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
});

// get users
app.get('/users', async (req, res) => {
  try {
    const query = {};
    const users = await usersCollection.find(query).toArray();

    res.send(users);

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
});

// admin role
app.put('/users/admin/:id', verifyJwt, verifyAdmin, async (req, res) => {
  try {
    // const decodedEmail = req.decoded.email;
    // const query = { email: decodedEmail };
    // const user = await usersCollection.findOne(query);
    // if (user?.role !== 'admin') {
    //   return res.status(403).send({ message: 'forbidden access' });
    // }

    const id = req.params.id;
    const filter = { _id: ObjectId(id) };
    const options = { upsert: true };
    const updatedDoc = {
      $set: {
        role: 'admin'
      }
    };
    const result = await usersCollection.updateOne(filter, updatedDoc, options);
    res.send(result);

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
});


app.get('/users/admin/:email', async (req, res) => {
  try {
    const email = req.params.email;
    const query = { email }
    const user = await usersCollection.findOne(query);
    res.send({ isAdmin: user?.role === 'admin' })

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
});

app.get('/appointmentSpecialty', async (req, res) => {
  try {
    const query = {};
    const result = await appointmentOptionCollection.find(query).project({ name: 1 }).toArray();

    res.send(result);

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
});

// post doctors data
app.post('/doctors', verifyJwt, verifyAdmin, async (req, res) => {
  try {
    const doctor = req.body;
    const result = await doctorsCollection.insertOne(doctor);

    res.send(result);

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    })
  }
});

// get doctors data
app.get('/doctors', verifyJwt, verifyAdmin, async (req, res) => {
  try {
    const query = {};
    const doctors = await doctorsCollection.find(query).toArray();
    res.send(doctors);

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    });
  }
});

// delete a doctor
app.delete('/doctors/:id', verifyJwt, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const query = { _id: ObjectId(id) };
    const result = await doctorsCollection.deleteOne(query);

    res.send(result);

  } catch (error) {
    res.send({
      success: false,
      error: error.message
    });
  }
});

// temporary to update price filed on appointment options
// app.get('/addPrice', async (req, res) => {
//   try {
//     const filter = {};
//     const options = { upsert: true };
//     const updatedDoc = {
//       $set: {
//         price: 99
//       }
//     };
//     const result = await appointmentOptionCollection.updateMany(filter, updatedDoc, options);
//     res.send(result);

//   } catch (error) {
//     res.send({
//       success: false,
//       error: error.message
//     });
//   }
// })

app.get('/', (req, res) => {
  res.send('Doctors portal server is running');
});

app.listen(port, () => {
  console.log(`Server is running on port: ${port}`);
});