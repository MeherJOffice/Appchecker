# Daily App Monitoring - Testing Guide

## 🎯 Feature Overview
The new daily monitoring system tracks published apps to detect if they get terminated before 3 weeks and sends notifications accordingly.

## ✅ Deployment Status
- ✅ **Functions deployed successfully** to Firebase
- ✅ **API endpoints working** (tested with real app ID)
- ✅ **Daily cron job scheduled** for 9:00 AM Africa/Tunis time
- ✅ **New `trackedApps` collection** ready for data

## 🧪 How to Test

### 1. **Test the Web Interface**
```bash
# Start the local development server
firebase serve --only hosting

# Open http://localhost:5000 in your browser
# Test with a real app ID like: 544007664
```

### 2. **Test via Slack Integration**
1. Go to your Slack workspace
2. Navigate to the configured submit channel
3. Paste an App Store link like: `https://apps.apple.com/us/app/angry-birds/id544007664`
4. The system will:
   - Check if the app is live
   - Announce it in the updates channel
   - Start tracking it for daily monitoring

### 3. **Test the Daily Tracking Function**
1. Go to [Firebase Console](https://console.firebase.google.com/project/davancitoolappcheck/functions)
2. Click on `dailyAppTracking` function
3. Click "Test" to manually trigger it
4. Check the logs for results

### 4. **Test with Manual Data Creation**
You can manually create test data in Firestore:

**Collection: `trackedApps`**
```json
{
  "id": "544007664",
  "bundleId": null,
  "name": "Test App",
  "link": "https://apps.apple.com/us/app/test/id544007664",
  "uploader": "test_user",
  "firstLiveAt": "2025-10-01T00:00:00Z",
  "lastCheckedAt": "2025-10-01T00:00:00Z",
  "status": "live",
  "terminationDate": null,
  "confirmationDate": null,
  "createdAt": "2025-10-01T00:00:00Z",
  "updatedAt": "2025-10-01T00:00:00Z"
}
```

## 📊 Expected Behavior

### **For Live Apps (not past 3 weeks):**
- Status remains `"live"`
- No notifications sent
- `lastCheckedAt` updated

### **For Apps Past 3 Weeks (still live):**
- Status changes to `"confirmed"`
- Confirmation message sent to updates channel:
  ```
  ✅ Test App is confirmed live after 3 weeks!
  Uploaded by @test_user
  https://apps.apple.com/us/app/test/id544007664
  ```

### **For Terminated Apps:**
- Status changes to `"terminated"`
- Termination message sent to updates channel:
  ```
  🚫 Test App has been terminated after 5 days.
  Uploaded by @test_user
  https://apps.apple.com/us/app/test/id544007664
  ```

## 🔍 Monitoring & Debugging

### **Check Function Logs:**
```bash
firebase functions:log --only dailyAppTracking
```

### **Check Firestore Data:**
1. Go to [Firebase Console > Firestore](https://console.firebase.google.com/project/davancitoolappcheck/firestore/data)
2. Look for `trackedApps` collection
3. Check app statuses and timestamps

### **Test API Endpoints:**
```bash
# Test main API
curl -X POST "https://us-central1-davancitoolappcheck.cloudfunctions.net/checkAppStatus" \
  -H "Content-Type: application/json" \
  -d '{"id": "544007664"}'

# Test with bundle ID
curl -X POST "https://us-central1-davancitoolappcheck.cloudfunctions.net/checkAppStatus" \
  -H "Content-Type: application/json" \
  -d '{"bundleId": "com.rovio.angrybirds"}'
```

## 📅 Schedule
- **Daily tracking runs at:** 9:00 AM Africa/Tunis time
- **Hourly monitoring runs at:** Every hour (for new app detection)
- **Monthly reports run at:** 23:55 daily (checks if last day of month)

## 🎉 Success Indicators
1. **Web interface** shows app availability correctly
2. **Slack integration** creates tracked apps when links are posted
3. **Daily function** processes tracked apps and updates statuses
4. **Notifications** are sent to the updates channel
5. **Monthly reports** include termination and confirmation statistics

## 🚨 Troubleshooting
- If functions don't trigger, check Firebase Console for errors
- If Slack integration fails, verify webhook URLs in Firebase config
- If apps aren't being tracked, check if they're being added to `trackedApps` collection
- If notifications aren't sent, verify Slack webhook configuration

## 📝 Next Steps
1. Test with real Slack integration
2. Monitor daily function execution
3. Verify notification delivery
4. Check monthly report generation
5. Fine-tune notification timing and content

