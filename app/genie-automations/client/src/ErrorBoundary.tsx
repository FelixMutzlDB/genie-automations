import React, { Component } from 'react';
import type { ReactNode } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@databricks/appkit-ui/react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error);
    console.error('Error details:', errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background p-4 flex items-center justify-center">
          <Card className="max-w-lg w-full">
            <CardHeader>
              <CardTitle>Something went wrong</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">Try reloading the page. Nothing you entered was changed.</p>
              <Button onClick={() => window.location.reload()}>Reload</Button>
              <Accordion type="single" collapsible>
                <AccordionItem value="technical-details">
                  <AccordionTrigger>Technical details</AccordionTrigger>
                  <AccordionContent>
                    <pre className="bg-muted p-3 rounded text-xs overflow-auto max-h-72 whitespace-pre-wrap">
                      {[this.state.error?.toString(), this.state.errorInfo?.componentStack, this.state.error?.stack]
                        .filter(Boolean)
                        .join('\n\n')}
                    </pre>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
