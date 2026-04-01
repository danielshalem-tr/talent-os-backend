// Triolla Talent OS — CI Pipeline
// Parameterized build: run against any branch (feature, release, main)
// Stages: Build → Test only. No auto-deploy — deploy is a manual human action.
// D-04, D-05, D-06: Build + Test CI gate; secrets in .env on server, not injected by Jenkins

pipeline {
    agent any

    parameters {
        // D-08: BRANCH_NAME enables staging validation without a separate Jenkinsfile
        // Default 'main' targets prod. Specify feature/release branch for staging builds.
        string(
            name: 'BRANCH_NAME',
            defaultValue: 'main',
            description: 'Branch to build and test. Default: main (prod). Use feature/release branch for staging.'
        )
    }

    environment {
        NODE_ENV = 'test'
    }

    stages {
        stage('Checkout') {
            steps {
                echo "Checking out branch: ${params.BRANCH_NAME}"
                checkout scmGit(
                    branches: [[name: "${params.BRANCH_NAME}"]],
                    userRemoteConfigs: scm.userRemoteConfigs
                )
            }
        }

        stage('Install') {
            steps {
                echo 'Installing dependencies...'
                sh 'npm ci'
            }
        }

        stage('Build') {
            steps {
                echo 'Compiling TypeScript...'
                sh 'npm run build'
            }
        }

        stage('Test') {
            steps {
                echo 'Running unit tests (CI gate)...'
                // D-05: Unit tests must pass to proceed; failing tests block pipeline
                sh 'npm run test'
            }
        }

        stage('Docker Build') {
            steps {
                echo 'Verifying Docker image builds cleanly...'
                sh "docker build -t triolla-backend:${params.BRANCH_NAME} ."
            }
        }
    }

    post {
        success {
            echo "Pipeline passed for branch: ${params.BRANCH_NAME}"
            echo "To deploy: SSH to server and run 'git pull && docker compose up -d --build'"
            echo "Or run: scripts/deploy.sh ${params.BRANCH_NAME}"
        }
        failure {
            echo "Pipeline FAILED for branch: ${params.BRANCH_NAME}"
            echo "Fix failing tests before deploying."
        }
    }

}
