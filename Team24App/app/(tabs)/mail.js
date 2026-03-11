import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Button, Text, View, FlatList, ActivityIndicator } from 'react-native';

WebBrowser.maybeCompleteAuthSession();

const discovery = {
  authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
};

export default function App() {
  const [emails, setEmails] = useState([]);
  const [loading, setLoading] = useState(false);

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: 'fde8d6d4-cb6f-4ad5-862f-0ab740a0bec8',
      scopes: ['openid', 'profile', 'email', 'User.Read', 'Mail.Read'], // Added Mail.Read
      redirectUri: AuthSession.makeRedirectUri({ scheme: 'team24app' }),
      responseType: AuthSession.ResponseType.Token,
      usePKCE: false,
    },
    discovery
  );

  // Fetch emails
  useEffect(() => {
    if (response?.type === 'success') {
      const { access_token } = response.params;
      fetchEmails(access_token);
    }
  }, [response]);

  const fetchEmails = async (token) => {
    setLoading(true);
    try {
      const res = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=10', {
        headers: { Authorization: `Bearer ${token}` },
      });
      
      const data = await res.json();
      console.log("Success! Emails found:", data.value.length);
      setEmails(data.value || []);
    } catch (error) {
      console.error("Network Error:", error);
    } finally {
      setLoading(false);
    }
  };

  // UI States
  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" /></View>;
  }

  return (
    <View style={{ flex: 1, paddingTop: 100, paddingHorizontal: 20 }}>
      {emails.length > 0 ? (
        <FlatList
          data={emails}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View style={{ marginBottom: 15, borderBottomWidth: 1, borderBottomColor: '#eee' }}>
              <Text style={{ fontWeight: 'bold' }}>{item.from?.emailAddress?.name || "Unknown"}</Text>
              <Text>{item.subject}</Text>
            </View>
          )}
        />
      ) : (
        <View style={styles.center}>
          <Button
            disabled={!request}
            title="Login with Microsoft"
            onPress={() => promptAsync()}
          />
        </View>
      )}
    </View>
  );
}

const styles = {
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' }
};