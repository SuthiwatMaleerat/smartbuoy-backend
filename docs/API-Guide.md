Smart Buoy API Documentation

Firebase Integration Guide for Flutter

**Firebase Project Details**
- Project ID: `smart-buoy-system-d96cb`
- Realtime Database URL: `https://smart-buoy-system-d96cb-default-rtdb.asia-southeast1.firebasedatabase.app/`
- Firestore Region: `asia-southeast1`

---

## Database Structure

### Realtime Database (Real-time Sensor Data)

#### Buoy Data Structure:
```
/buoys/{buoyId}/
├── info/
│   ├── name: "Buoy Station Alpha"
│   ├── location: "Chao Phraya River - Bangkok"  
│   ├── coordinates/
│   │   ├── lat: 13.7563
│   │   └── lng: 100.5018
│   ├── owner_id: "test_user_001"
│   ├── status: "active"
│   └── last_seen: "2025-09-16T10:30:00Z"
├── sensors/
│   └── current/
│       ├── timestamp: "2025-09-16T10:30:00Z"
│       ├── ph: 7.2
│       ├── dissolved_oxygen: 8.5
│       ├── tds: 150
│       ├── turbidity: 2.3
│       ├── temperature: 28.5
│       ├── rainfall: 0.0
│       └── battery_level: 85
└── history/
    └── {date}/
        └── {time}/
            ├── ph: 7.2
            ├── dissolved_oxygen: 8.5
            ├── tds: 150
            ├── turbidity: 2.3
            ├── temperature: 28.5
            └── rainfall: 0.0
```

#### Available Buoys:
- `buoy_001` - Bangkok Station (lat: 13.7563, lng: 100.5018)
- `buoy_002` - Chiang Mai Station (lat: 18.7883, lng: 98.9853)

---

### Firestore Database (User Data & Processed Info)

#### Collections:

**1. users Collection:**
```json
{
  "user_id": {
    "email": "user@example.com",
    "name": "John Doe",
    "role": "user",
    "buoys": ["buoy_001"],
    "created_at": "2025-09-01T00:00:00Z",
    "last_login": "2025-09-16T09:00:00Z"
  }
}
```

**2. alerts Collection:**
```json
{
  "alert_id": {
    "buoy_id": "buoy_001",
    "type": "warning", // "info", "warning", "critical"
    "parameter": "ph",
    "value": 6.8,
    "threshold": 7.0,
    "message": "pH level is slightly below optimal range",
    "timestamp": "2025-09-16T10:28:00Z",
    "status": "active", // "active", "acknowledged"
    "acknowledged_by": null,
    "acknowledged_at": null
  }
}
```

**3. buoy_registry Collection:**
```json
{
  "buoy_id": {
    "serial_number": "BUOY_001",
    "name": "River Station 1",
    "location": {
      "name": "Chao Phraya River - Bangkok",
      "coordinates": {"lat": 13.7563, "lng": 100.5018}
    },
    "owner_id": "user123",
    "status": "active",
    "registered_at": "2025-09-01T00:00:00Z"
  }
}
```

**4. system_config Collection:**
```json
{
  "sensor_thresholds": {
    "ph": {
      "min_critical": 6.0,
      "min_warning": 6.5,
      "max_warning": 8.5,
      "max_critical": 9.0,
      "unit": "pH"
    },
    "dissolved_oxygen": {
      "min_critical": 4.0,
      "min_warning": 5.0,
      "max_warning": 12.0,
      "max_critical": 15.0,
      "unit": "mg/L"
    }
    // ... other sensors
  }
}
```

---

## Flutter Integration Code Examples

### 1. Firebase Setup (pubspec.yaml):
```yaml
dependencies:
  flutter:
    sdk: flutter
  firebase_core: ^2.24.2
  firebase_auth: ^4.15.3
  firebase_database: ^10.4.0
  cloud_firestore: ^4.13.6
```

### 2. Initialize Firebase:
```dart
// main.dart
import 'package:firebase_core/firebase_core.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();
  runApp(MyApp());
}
```

### 3. Real-time Data Listening:
```dart
// Get current sensor data
Stream<DatabaseEvent> getCurrentSensorData(String buoyId) {
  return FirebaseDatabase.instance
      .ref('/buoys/$buoyId/sensors/current')
      .onValue;
}

// Usage in Widget
StreamBuilder<DatabaseEvent>(
  stream: getCurrentSensorData('buoy_001'),
  builder: (context, snapshot) {
    if (snapshot.hasData) {
      Map<dynamic, dynamic> data = snapshot.data!.snapshot.value as Map;
      return Column(
        children: [
          Text('pH: ${data['ph']}'),
          Text('Temperature: ${data['temperature']}°C'),
          Text('DO: ${data['dissolved_oxygen']} mg/L'),
        ],
      );
    }
    return CircularProgressIndicator();
  },
)
```

### 4. Get Historical Data:
```dart
Future<Map<String, dynamic>> getHistoricalData(String buoyId, String date) async {
  DatabaseReference ref = FirebaseDatabase.instance.ref('/buoys/$buoyId/history/$date');
  DataSnapshot snapshot = await ref.get();
  
  if (snapshot.exists) {
    return Map<String, dynamic>.from(snapshot.value as Map);
  }
  return {};
}
```

### 5. Get User's Buoys:
```dart
Future<List<String>> getUserBuoys(String userId) async {
  DocumentSnapshot doc = await FirebaseFirestore.instance
      .collection('users')
      .doc(userId)
      .get();
  
  if (doc.exists) {
    List<dynamic> buoys = doc.get('buoys');
    return buoys.cast<String>();
  }
  return [];
}
```

### 6. Get Alerts:
```dart
Stream<QuerySnapshot> getActiveAlerts(String buoyId) {
  return FirebaseFirestore.instance
      .collection('alerts')
      .where('buoy_id', isEqualTo: buoyId)
      .where('status', isEqualTo: 'active')
      .orderBy('timestamp', descending: true)
      .snapshots();
}
```

### 7. Authentication:
```dart
// Login
Future<UserCredential> loginUser(String email, String password) async {
  return await FirebaseAuth.instance.signInWithEmailAndPassword(
    email: email,
    password: password,
  );
}

// Register  
Future<UserCredential> registerUser(String email, String password) async {
  return await FirebaseAuth.instance.createUserWithEmailAndPassword(
    email: email,
    password: password,
  );
}
```

---

## App Flow Recommendations

### 1. Login Screen:
- Firebase Authentication
- Store user session

### 2. Dashboard:
- Show user's buoys
- Real-time sensor data cards
- Quick status indicators

### 3. Buoy Detail Screen:
- Live sensor readings
- Historical charts (last 24h, 7 days)
- Alert notifications

### 4. Alerts Screen:
- List of active alerts
- Alert history
- Acknowledge alerts

### 5. Settings:
- User profile
- Notification preferences

---

## UI/UX Suggestions

### Sensor Display Cards:
```dart
Card(
  child: Column(
    children: [
      Text('pH Level'),
      Text('7.2', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      LinearProgressIndicator(value: 0.8), // Based on threshold
      Text('Normal', style: TextStyle(color: Colors.green))
    ],
  ),
)
```

### Status Colors:
- Green: Normal (within optimal range)
- Yellow: Warning (approaching limits) 
- Red: Critical (exceeds safe limits)
- Gray: Offline/No data

### Chart Libraries:
- `fl_chart` for line charts
- `charts_flutter` for complex visualizations

---

## Important Notes

### Test Users:
- Email: `user1@smartbuoy.com` / Password: Create in Firebase Auth
- Email: `user2@smartbuoy.com` / Password: Create in Firebase Auth

### Data Update Frequency:
- Real-time data: Every 30 seconds (from Arduino)
- Historical data: Stored every 5 minutes
- Battery updates: Every hour

### Error Handling:
- Check for internet connection
- Handle Firebase exceptions
- Provide offline mode indicators

### Performance Tips:
- Use `StreamBuilder` for real-time data
- Implement data caching for offline usage  
- Limit historical data queries (max 100 records)

---

## Next Steps for Backend

1. Security Rules (High Priority)
2. Cloud Functions for alerts
3. Push notifications
4. ML forecasting service

---

## Support

For any questions about the API or data structure, contact the backend team.

Last Updated: September 2025