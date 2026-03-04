import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Button, Text, View } from 'react-native';

WebBrowser.maybeCompleteAuthSession();

const discovery = {
  authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
};

// properties accepted by the auth component
interface AuthProps {
  onSuccess?: (accessToken: string) => void;
}

export default function Auth({ onSuccess }: AuthProps) {
  console.log('OAuth');

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: 'fde8d6d4-cb6f-4ad5-862f-0ab740a0bec8',
      scopes: ['https://graph.microsoft.com/.default'],
      redirectUri: AuthSession.makeRedirectUri({
        scheme: 'team24app',
      }),
    },
    discovery
  );

  // debug: print the URI once the request object is ready
  useEffect(() => {
    if (request) {
      console.log('Auth request created, redirectUri =', request.redirectUri);
    }
  }, [request]);
  console.log('redirectUri:', request?.redirectUri);

  // when the OAuth response arrives, notify parent
  useEffect(() => {
    if (response) {
      console.log('OAuth response received', response);
      console.log('Response type:', response.type);
      console.log('Has access token:', !!response.params?.access_token);
    }
    if (response?.type === 'success') {
      const token = response.params.access_token;
      console.log('Login successful, token exists:', !!token);
      console.log('onSuccess callback exists:', !!onSuccess);
      if (onSuccess && token) {
        console.log('Calling onSuccess callback');
        onSuccess(token);
      }
    }
  }, [response, onSuccess]);

  // Check if we are logged in
  const isLoggedIn = response?.type === 'success';

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      {isLoggedIn ? (
        <Text style={{ fontSize: 16 }}>Connected to Outlook</Text>
      ) : (
        <Button
          disabled={!request}
          title="Login with Microsoft"
          onPress={() => {
            promptAsync();
          }}
        />
      )}
    </View>
  );
}