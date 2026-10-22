// Firebase project used for accounts and the shared family database.
// These values are public by design (they identify the project); access is
// controlled by the Firestore security rules in firestore.rules.
export const FIREBASE = {
  apiKey: 'AIzaSyAuz2-WwvwzOFVetkg9JVteGUIK2Kb8OYg',
  projectId: 'my-finances-family',
};

// Emails that can see every family member's records. Must match firestore.rules.
export const ADMIN_EMAILS = ['lakkireddysurender@gmail.com', 'lakki911@gmail.com'];
