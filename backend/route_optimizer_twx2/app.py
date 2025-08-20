from Flaskr import create_app

app = create_app()

if __name__ == "__main__":
    app.run(debug=True, threaded=True, port=5000) #change port if there's conflict